//! Thread compaction — summarize older messages to fit within budget.

use crate::tokenizer::{count_tokens_fast, truncate_to_tokens};

/// Compact a conversation thread to fit within `max_tokens`.
///
/// If the thread already fits, returns it unchanged. Otherwise applies
/// extractive summarization.
pub fn compact_thread(text: &str, max_tokens: usize) -> String {
    if count_tokens_fast(text) <= max_tokens {
        return text.to_string();
    }
    extractive_summarize(text, max_tokens)
}

/// Extractive summarization: keep first 2 + last 2 lines, condense the middle.
///
/// For texts with 4 or fewer lines, falls back to simple truncation.
pub fn extractive_summarize(text: &str, max_tokens: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();

    if lines.len() <= 4 {
        return truncate_to_tokens(text, max_tokens);
    }

    let head: Vec<&str> = lines[..2].to_vec();
    let tail: Vec<&str> = lines[lines.len() - 2..].to_vec();
    let condensed_count = lines.len() - 4;

    let mut result = head.join("\n");
    result.push_str(&format!("\n... ({condensed_count} messages condensed) ...\n"));
    result.push_str(&tail.join("\n"));

    // If the result still exceeds budget, truncate it.
    if count_tokens_fast(&result) > max_tokens {
        truncate_to_tokens(&result, max_tokens)
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_thread_unchanged() {
        let text = "line1\nline2\nline3";
        assert_eq!(compact_thread(text, 1000), text);
    }

    #[test]
    fn long_thread_compacted() {
        let lines: Vec<String> = (0..20).map(|i| format!("message {i}")).collect();
        let text = lines.join("\n");
        let result = compact_thread(&text, 30);
        assert!(result.contains("messages condensed"));
        assert!(result.contains("message 0"));
        assert!(result.contains("message 19"));
    }

    #[test]
    fn extractive_keeps_head_and_tail() {
        let text = "a\nb\nc\nd\ne\nf\ng";
        let result = extractive_summarize(text, 100);
        assert!(result.starts_with("a\nb\n"));
        assert!(result.ends_with("f\ng"));
        assert!(result.contains("3 messages condensed"));
    }
}
