use anyhow::Result;
use hq_core::config::HqConfig;
use hq_vault::VaultClient;

/// Show usage statistics — tokens, costs, activity.
pub async fn run(config: &HqConfig, sub: &str) -> Result<()> {
    let vault = VaultClient::new(config.vault_path.clone())?;

    match sub {
        "summary" | "" => {
            let summary = vault.get_usage_summary()?;

            println!("Usage Summary");
            println!("=============\n");

            if summary.total_calls == 0 {
                println!("No usage data recorded yet.");
                println!("Usage is tracked in: {}", config.vault_path.join("_usage/daily/").display());
                return Ok(());
            }

            println!("Total calls:       {}", summary.total_calls);
            println!("Total tokens:      {}", format_tokens(summary.total_tokens));
            println!("  Prompt tokens:   {}", format_tokens(summary.total_prompt_tokens));
            println!("  Completion:      {}", format_tokens(summary.total_completion_tokens));
            println!("Total cost:        ${:.4}", summary.total_cost);
            println!("Date range:        {} to {}", summary.date_range.0, summary.date_range.1);

            if !summary.models_used.is_empty() {
                println!("\nModels used:");
                for model in &summary.models_used {
                    println!("  - {}", model);
                }
            }

            if !summary.daily_breakdown.is_empty() {
                println!("\nDaily breakdown (last 7 days):");
                let start = summary.daily_breakdown.len().saturating_sub(7);
                for day in &summary.daily_breakdown[start..] {
                    println!(
                        "  {} — {} tokens, ${:.4}, {} calls",
                        day.date,
                        format_tokens(day.tokens),
                        day.cost,
                        day.calls,
                    );
                }
            }
        }
        "activity" | "recent" => {
            let activity = vault.get_recent_activity(20)?;

            println!("Recent Activity");
            println!("===============\n");

            if activity.is_empty() {
                println!("No recent activity.");
                return Ok(());
            }

            for entry in &activity {
                println!("  {} — {} — {}", entry.timestamp, entry.action, entry.details);
            }
        }
        _ => {
            println!("Usage: hq usage [summary|activity]");
            println!();
            println!("Subcommands:");
            println!("  summary     Show aggregated usage stats (default)");
            println!("  activity    Show recent activity log");
        }
    }

    Ok(())
}

fn format_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{:.1}K", tokens as f64 / 1_000.0)
    } else {
        tokens.to_string()
    }
}
