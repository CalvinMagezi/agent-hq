//! The main context assembly engine.

use std::collections::HashMap;

use anyhow::Result;
use tracing::{debug, info};
use uuid::Uuid;

use hq_core::types::{
    ContextFrame, ContextInjection, ConversationTurn, LayerBudget, TokenBudget,
};

use crate::budget::{cascade_surplus, compute_allocations, profile_by_name};
use crate::compactor::compact_thread;
use crate::layers::FrameInput;
use crate::tokenizer::{count_tokens_fast, truncate_to_tokens};

/// The context assembly engine.
///
/// Stateless — call [`build_frame`](ContextEngine::build_frame) with a
/// [`FrameInput`] each turn.
#[derive(Debug, Clone)]
pub struct ContextEngine;

impl ContextEngine {
    /// Create a new engine instance.
    pub fn new() -> Self {
        Self
    }

    /// Build a fully token-budgeted context frame.
    ///
    /// Assembly order:
    /// 1. Resolve budget profile
    /// 2. Layer 1 — System: SOUL + harness instructions
    /// 3. Layer 2 — UserMessage: the current user turn
    /// 4. Layer 3 — Memory: long-term facts (private tags stripped)
    /// 5. Surplus cascading (thread 0.50, injections 0.35, memory 0.15)
    /// 6. Layer 4 — Thread: recent messages, older ones compacted
    /// 7. Layer 5 — Injections: pinned notes + search results
    /// 8. Final TokenBudget assembly
    pub fn build_frame(&self, input: FrameInput) -> Result<ContextFrame> {
        let frame_id = Uuid::new_v4().to_string();
        info!(frame_id = %frame_id, profile = %input.profile, total = input.total_tokens, "building context frame");

        // Step 1: Resolve budget profile and compute allocations.
        let profile = profile_by_name(&input.profile);
        let allocations = compute_allocations(input.total_tokens, &profile);
        debug!(?allocations, "initial allocations");

        let mut usage: HashMap<String, usize> = HashMap::new();
        let mut layers: HashMap<String, LayerBudget> = HashMap::new();

        // Step 2: Layer 1 — System (SOUL + harness instructions).
        let system_budget = allocations["system"];
        let system_raw = if input.harness_instructions.is_empty() {
            input.soul.clone()
        } else {
            format!("{}\n\n---\n\n{}", input.soul, input.harness_instructions)
        };
        let system = truncate_to_tokens(&system_raw, system_budget);
        let system_used = count_tokens_fast(&system);
        usage.insert("system".to_string(), system_used);
        layers.insert(
            "system".to_string(),
            LayerBudget {
                allocated: system_budget,
                used: system_used,
                compacted: 0,
            },
        );
        debug!(system_used, system_budget, "layer 1: system");

        // Step 3: Layer 2 — UserMessage.
        let user_budget = allocations["user_message"];
        let user_message = truncate_to_tokens(&input.user_message, user_budget);
        let user_used = count_tokens_fast(&user_message);
        usage.insert("user_message".to_string(), user_used);
        layers.insert(
            "user_message".to_string(),
            LayerBudget {
                allocated: user_budget,
                used: user_used,
                compacted: 0,
            },
        );
        debug!(user_used, user_budget, "layer 2: user_message");

        // Step 4: Layer 3 — Memory (strip private tags).
        let memory_budget = allocations["memory"];
        let memory_clean = strip_private_tags(&input.memory, &input.private_tags);
        let memory = truncate_to_tokens(&memory_clean, memory_budget);
        let memory_used = count_tokens_fast(&memory);
        usage.insert("memory".to_string(), memory_used);
        layers.insert(
            "memory".to_string(),
            LayerBudget {
                allocated: memory_budget,
                used: memory_used,
                compacted: 0,
            },
        );
        debug!(memory_used, memory_budget, "layer 3: memory");

        // Response reserve (not filled by us).
        let response_budget = allocations["response"];
        usage.insert("response".to_string(), 0);
        layers.insert(
            "response".to_string(),
            LayerBudget {
                allocated: response_budget,
                used: 0,
                compacted: 0,
            },
        );

        // Step 5: Surplus cascading.
        let cascaded = cascade_surplus(&allocations, &usage);
        debug!(?cascaded, "post-cascade allocations");

        // Step 6: Layer 4 — Thread.
        let thread_budget = cascaded["thread"];
        let (turns, thread_used, thread_compacted) =
            build_thread(&input.thread, thread_budget);
        usage.insert("thread".to_string(), thread_used);
        layers.insert(
            "thread".to_string(),
            LayerBudget {
                allocated: thread_budget,
                used: thread_used,
                compacted: thread_compacted,
            },
        );
        debug!(thread_used, thread_budget, thread_compacted, "layer 4: thread");

        // Step 7: Layer 5 — Injections.
        let injection_budget = cascaded["injections"];
        let injections = build_injections(
            &input.pinned_notes,
            &input.search_results,
            injection_budget,
        );
        let injection_used: usize = injections.iter().map(|i| i.tokens).sum();
        usage.insert("injections".to_string(), injection_used);
        layers.insert(
            "injections".to_string(),
            LayerBudget {
                allocated: injection_budget,
                used: injection_used,
                compacted: 0,
            },
        );
        debug!(injection_used, injection_budget, count = injections.len(), "layer 5: injections");

        // Step 8: Build final TokenBudget.
        let total_used: usize = usage.values().sum();
        let remaining = input.total_tokens.saturating_sub(total_used);
        let utilization_pct = if input.total_tokens > 0 {
            total_used as f64 / input.total_tokens as f64 * 100.0
        } else {
            0.0
        };

        let budget = TokenBudget {
            limit: input.total_tokens,
            layers,
            remaining,
            total_used,
            utilization_pct,
        };

        info!(
            frame_id = %frame_id,
            total_used,
            remaining,
            utilization_pct = format!("{:.1}%", utilization_pct),
            "context frame built"
        );

        Ok(ContextFrame {
            frame_id,
            system,
            memory,
            turns,
            injections,
            user_message,
            budget,
        })
    }
}

impl Default for ContextEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Helpers ───────────────────────────────────────────────────

/// Strip lines containing any of the private tags from memory text.
fn strip_private_tags(memory: &str, private_tags: &[String]) -> String {
    if private_tags.is_empty() {
        return memory.to_string();
    }
    memory
        .lines()
        .filter(|line| {
            !private_tags
                .iter()
                .any(|tag| line.contains(tag.as_str()))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Build conversation turns from thread messages, compacting older ones
/// to fit the budget.
fn build_thread(
    messages: &[hq_core::types::ConversationMessage],
    budget: usize,
) -> (Vec<ConversationTurn>, usize, usize) {
    if messages.is_empty() {
        return (Vec::new(), 0, 0);
    }

    // First pass: convert all messages to turns.
    let all_turns: Vec<ConversationTurn> = messages
        .iter()
        .map(|m| {
            let tokens = count_tokens_fast(&m.content);
            ConversationTurn {
                role: m.role.clone(),
                content: m.content.clone(),
                tokens,
                compacted: false,
            }
        })
        .collect();

    let total_tokens: usize = all_turns.iter().map(|t| t.tokens).sum();

    if total_tokens <= budget {
        return (all_turns, total_tokens, 0);
    }

    // Compact older messages to fit budget.
    // Keep the most recent messages intact, compact earlier ones.
    let mut result = Vec::new();
    let mut used = 0usize;
    let mut compacted_count = 0usize;

    // Reserve recent messages (work backwards).
    let mut recent: Vec<ConversationTurn> = Vec::new();
    let mut recent_tokens = 0usize;

    for turn in all_turns.iter().rev() {
        if recent_tokens + turn.tokens <= budget / 2 {
            recent_tokens += turn.tokens;
            recent.push(turn.clone());
        } else {
            break;
        }
    }
    recent.reverse();

    // Compact older messages.
    let older_count = all_turns.len() - recent.len();
    if older_count > 0 {
        let older_text: String = all_turns[..older_count]
            .iter()
            .map(|t| format!("[{}] {}", t.role, t.content))
            .collect::<Vec<_>>()
            .join("\n");

        let remaining_budget = budget.saturating_sub(recent_tokens);
        let compacted_text = compact_thread(&older_text, remaining_budget);
        let compacted_tokens = count_tokens_fast(&compacted_text);

        result.push(ConversationTurn {
            role: "system".to_string(),
            content: compacted_text,
            tokens: compacted_tokens,
            compacted: true,
        });
        used += compacted_tokens;
        compacted_count = older_count;
    }

    for turn in recent {
        used += turn.tokens;
        result.push(turn);
    }

    (result, used, compacted_count)
}

/// Build injection entries from pinned notes and search results,
/// fitting within the given token budget.
fn build_injections(
    pinned_notes: &[hq_core::types::Note],
    search_results: &[hq_core::types::SearchResult],
    budget: usize,
) -> Vec<ContextInjection> {
    let mut injections = Vec::new();
    let mut remaining = budget;

    // Pinned notes first (highest priority).
    for note in pinned_notes {
        let content = truncate_to_tokens(&note.content, remaining);
        let tokens = count_tokens_fast(&content);
        if tokens > remaining {
            break;
        }
        injections.push(ContextInjection {
            source: note.path.clone(),
            label: note.title.clone(),
            content,
            tokens,
            score: 1.0,
            tier: Some("pinned".to_string()),
        });
        remaining = remaining.saturating_sub(tokens);
    }

    // Search results (progressive disclosure — take highest relevance first).
    for result in search_results {
        if remaining == 0 {
            break;
        }
        let content = truncate_to_tokens(&result.snippet, remaining);
        let tokens = count_tokens_fast(&content);
        if tokens > remaining {
            break;
        }
        injections.push(ContextInjection {
            source: result.note_path.clone(),
            label: result.title.clone(),
            content,
            tokens,
            score: result.relevance,
            tier: Some("search".to_string()),
        });
        remaining = remaining.saturating_sub(tokens);
    }

    injections
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layers::FrameInput;

    fn minimal_input() -> FrameInput {
        FrameInput {
            profile: "standard".to_string(),
            total_tokens: 4000,
            soul: "You are a helpful assistant.".to_string(),
            harness_instructions: String::new(),
            user_message: "Hello, how are you?".to_string(),
            memory: "User prefers concise answers.".to_string(),
            private_tags: vec![],
            thread: vec![],
            pinned_notes: vec![],
            search_results: vec![],
        }
    }

    #[test]
    fn build_frame_succeeds() {
        let engine = ContextEngine::new();
        let frame = engine.build_frame(minimal_input()).unwrap();
        assert!(!frame.frame_id.is_empty());
        assert!(frame.budget.total_used <= frame.budget.limit);
    }

    #[test]
    fn strip_private_tags_works() {
        let memory = "public fact\n#private secret\nanother fact";
        let result = strip_private_tags(memory, &["#private".to_string()]);
        assert!(!result.contains("#private"));
        assert!(result.contains("public fact"));
    }

    #[test]
    fn budget_utilization_is_sane() {
        let engine = ContextEngine::new();
        let frame = engine.build_frame(minimal_input()).unwrap();
        assert!(frame.budget.utilization_pct >= 0.0);
        assert!(frame.budget.utilization_pct <= 100.0);
    }
}
