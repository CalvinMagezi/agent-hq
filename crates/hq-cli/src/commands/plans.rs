use anyhow::Result;
use hq_core::config::HqConfig;
use std::collections::HashMap;
use std::path::Path;

/// Browse cross-agent plans: list, status, search.
pub async fn run(config: &HqConfig, sub: &str, arg: Option<&str>) -> Result<()> {
    let vault_path = &config.vault_path;
    let active_dir = vault_path.join("_plans/active");
    let archive_dir = vault_path.join("_plans/archive");

    match sub {
        "list" | "ls" | "" => {
            let plans = scan_plans(&active_dir, &archive_dir)?;
            if plans.is_empty() {
                println!("No plans found.");
                println!("Create one via HQ tools: hq jobs create \"plan: ...\"");
                return Ok(());
            }

            println!("\nPlans ({})\n", plans.len());
            for plan in &plans {
                let default_status = "?".to_string();
                let status = plan.get("status").unwrap_or(&default_status);
                let default_title = "untitled".to_string();
                let title = plan.get("title").or_else(|| plan.get("planId")).unwrap_or(&default_title);
                let default_mode = String::new();
                let mode = plan.get("planningMode").unwrap_or(&default_mode);
                let mode_icon = match mode.as_str() {
                    "act" => ">>",
                    "sketch" => "~~",
                    "blueprint" => "##",
                    _ => "  ",
                };

                println!("  {:<12} {} {}", status, mode_icon, title);
                if let Some(id) = plan.get("planId") {
                    let default_project = "default".to_string();
                    let project = plan.get("project").unwrap_or(&default_project);
                    println!("  {:<12}    {} -- {}", "", id, project);
                }
            }
            println!("\n  Use `hq plans status <planId>` for details");
        }
        "status" | "show" => {
            let plan_id = arg.ok_or_else(|| anyhow::anyhow!("Usage: hq plans status <planId>"))?;
            let plan = read_plan_dir(&active_dir.join(plan_id))
                .or_else(|| read_plan_dir(&archive_dir.join(plan_id)));

            match plan {
                Some(p) => {
                    let default_title = plan_id.to_string();
                    let title = p.get("title").unwrap_or(&default_title);
                    println!("\nPlan: {}\n", title);
                    let default_id = plan_id.to_string();
                    println!("  ID:       {}", p.get("planId").unwrap_or(&default_id));
                    let default_q = "?".to_string();
                    println!("  Status:   {}", p.get("status").unwrap_or(&default_q));
                    let default_unknown = "unknown".to_string();
                    println!("  Mode:     {}", p.get("planningMode").unwrap_or(&default_unknown));
                    let default_proj = "default".to_string();
                    println!("  Project:  {}", p.get("project").unwrap_or(&default_proj));
                    if let Some(created) = p.get("createdAt") {
                        println!("  Created:  {}", created);
                    }
                    if let Some(updated) = p.get("updatedAt") {
                        println!("  Updated:  {}", updated);
                    }
                }
                None => {
                    println!("Plan not found: {}", plan_id);
                }
            }
        }
        "search" => {
            let query = arg.ok_or_else(|| anyhow::anyhow!("Usage: hq plans search <query>"))?;
            let query_lower = query.to_lowercase();
            let all_plans = scan_plans(&active_dir, &archive_dir)?;
            let empty = String::new();

            let matches: Vec<_> = all_plans
                .iter()
                .filter(|p| {
                    let title = p.get("title").unwrap_or(&empty).to_lowercase();
                    let id = p.get("planId").unwrap_or(&empty).to_lowercase();
                    let project = p.get("project").unwrap_or(&empty).to_lowercase();
                    title.contains(&query_lower)
                        || id.contains(&query_lower)
                        || project.contains(&query_lower)
                })
                .collect();

            if matches.is_empty() {
                println!("No plans matching \"{}\"", query);
            } else {
                println!("\nPlans matching \"{}\" ({})\n", query, matches.len());
                let default_status = "?".to_string();
                let default_title = "untitled".to_string();
                for plan in &matches {
                    let status = plan.get("status").unwrap_or(&default_status);
                    let title = plan.get("title").unwrap_or(&default_title);
                    println!("  {:<12} {}", status, title);
                }
            }
        }
        _ => {
            println!("Usage: hq plans <subcommand>");
            println!();
            println!("Subcommands:");
            println!("  list              List all plans");
            println!("  status <planId>   Show plan details");
            println!("  search <query>    Search plans by title/project");
        }
    }

    Ok(())
}

fn scan_plans(
    active_dir: &Path,
    archive_dir: &Path,
) -> Result<Vec<HashMap<String, String>>> {
    let mut plans = Vec::new();

    for dir in [active_dir, archive_dir] {
        if !dir.exists() {
            continue;
        }
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            if entry.path().is_dir()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("plan-")
            {
                if let Some(plan) = read_plan_dir(&entry.path()) {
                    plans.push(plan);
                }
            }
        }
    }

    Ok(plans)
}

fn read_plan_dir(dir: &Path) -> Option<HashMap<String, String>> {
    let plan_md = dir.join("plan.md");
    if !plan_md.exists() {
        return None;
    }

    let raw = std::fs::read_to_string(&plan_md).ok()?;

    // Quick frontmatter parse
    let fm_match = raw.strip_prefix("---\n")?;
    let end = fm_match.find("\n---")?;
    let fm_str = &fm_match[..end];

    let mut map = HashMap::new();
    for line in fm_str.lines() {
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_string();
            let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
            if !key.is_empty() && !value.is_empty() {
                map.insert(key, value);
            }
        }
    }

    Some(map)
}
