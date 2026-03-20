//! Usage tracking — token counts, costs, and activity logs.
//!
//! Usage data is stored as NDJSON files under `_usage/daily/YYYY-MM-DD.jsonl`.

use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tracing::debug;

const USAGE_DIR: &str = "_usage/daily";

/// A single usage entry (one LLM call).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEntry {
    pub timestamp: String,
    pub agent: String,
    pub model: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub cost: f64,
    #[serde(default)]
    pub job_id: Option<String>,
}

/// An activity entry from recent logs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityEntry {
    pub timestamp: String,
    pub agent: String,
    pub action: String,
    pub details: String,
}

/// Aggregated usage summary.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageSummary {
    pub total_tokens: u64,
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_cost: f64,
    pub total_calls: usize,
    pub models_used: Vec<String>,
    pub date_range: (String, String),
    pub daily_breakdown: Vec<DailyUsage>,
}

/// Usage for a single day.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyUsage {
    pub date: String,
    pub tokens: u64,
    pub cost: f64,
    pub calls: usize,
}

/// Record a single LLM usage event.
pub fn record_usage(
    vault_path: &Path,
    agent: &str,
    model: &str,
    prompt_tokens: u64,
    completion_tokens: u64,
    cost: f64,
    job_id: Option<&str>,
) -> Result<()> {
    let now = Utc::now();
    let date_str = now.format("%Y-%m-%d").to_string();

    let dir = vault_path.join(USAGE_DIR);
    std::fs::create_dir_all(&dir)?;

    let file_path = dir.join(format!("{}.jsonl", date_str));

    let entry = UsageEntry {
        timestamp: now.to_rfc3339(),
        agent: agent.to_string(),
        model: model.to_string(),
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
        cost,
        job_id: job_id.map(|s| s.to_string()),
    };

    let line = serde_json::to_string(&entry)? + "\n";

    use std::fs::OpenOptions;
    use std::io::Write;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)?;
    file.write_all(line.as_bytes())?;

    debug!(model = model, tokens = prompt_tokens + completion_tokens, "recorded usage");
    Ok(())
}

/// Read recent activity from job logs.
pub fn get_recent_activity(vault_path: &Path, limit: usize) -> Result<Vec<ActivityEntry>> {
    let logs_dir = vault_path.join("_logs");
    if !logs_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();

    // Read log files, sorted by modification time (newest first)
    let mut files: Vec<_> = std::fs::read_dir(&logs_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|ext| ext == "md" || ext == "jsonl" || ext == "log")
        })
        .collect();

    files.sort_by(|a, b| {
        b.metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
            .cmp(
                &a.metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
            )
    });

    for file_entry in files.iter().take(limit) {
        let path = file_entry.path();
        let filename = path.file_name().unwrap_or_default().to_string_lossy();

        if let Ok(content) = std::fs::read_to_string(&path) {
            let modified = file_entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| chrono::DateTime::<Utc>::from(t).to_rfc3339())
                .unwrap_or_default();

            // Extract first non-empty line as details
            let first_line = content
                .lines()
                .find(|l| !l.trim().is_empty() && !l.starts_with("---"))
                .unwrap_or("(empty)")
                .to_string();

            entries.push(ActivityEntry {
                timestamp: modified,
                agent: "system".to_string(),
                action: format!("log: {}", filename),
                details: first_line.chars().take(200).collect(),
            });
        }

        if entries.len() >= limit {
            break;
        }
    }

    Ok(entries)
}

/// Compute aggregated usage summary from daily files.
pub fn get_usage_summary(vault_path: &Path) -> Result<UsageSummary> {
    let dir = vault_path.join(USAGE_DIR);
    if !dir.exists() {
        return Ok(UsageSummary::default());
    }

    let mut summary = UsageSummary::default();
    let mut models = std::collections::HashSet::new();
    let mut min_date = String::from("9999-99-99");
    let mut max_date = String::from("0000-00-00");

    let mut files: Vec<_> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|ext| ext == "jsonl")
        })
        .collect();

    files.sort_by_key(|e| e.file_name());

    for file_entry in &files {
        let path = file_entry.path();
        let date = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        if date < min_date {
            min_date = date.clone();
        }
        if date > max_date {
            max_date = date.clone();
        }

        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("reading usage file: {}", path.display()))?;

        let mut daily = DailyUsage {
            date: date.clone(),
            tokens: 0,
            cost: 0.0,
            calls: 0,
        };

        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(entry) = serde_json::from_str::<UsageEntry>(line) {
                summary.total_tokens += entry.total_tokens;
                summary.total_prompt_tokens += entry.prompt_tokens;
                summary.total_completion_tokens += entry.completion_tokens;
                summary.total_cost += entry.cost;
                summary.total_calls += 1;
                models.insert(entry.model);

                daily.tokens += entry.total_tokens;
                daily.cost += entry.cost;
                daily.calls += 1;
            }
        }

        summary.daily_breakdown.push(daily);
    }

    summary.models_used = models.into_iter().collect();
    summary.models_used.sort();
    summary.date_range = (min_date, max_date);

    Ok(summary)
}
