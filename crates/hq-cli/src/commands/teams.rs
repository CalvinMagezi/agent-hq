use anyhow::Result;
use hq_core::config::HqConfig;
use hq_vault::VaultClient;

/// List teams and manage team workflows.
pub async fn run(config: &HqConfig, sub: &str, args: &[String]) -> Result<()> {
    let vault = VaultClient::new(config.vault_path.clone())?;

    match sub {
        "list" | "ls" | "" => {
            println!("Agent Teams");
            println!("===========\n");

            // Built-in vertical teams
            let teams = [
                ("engineering", "Code generation, refactoring, debugging"),
                ("qa", "Testing, review, reality checking"),
                ("research", "Fact-checking, market analysis, web research"),
                ("content", "Technical writing, documentation"),
                ("ops", "DevOps, deployment, monitoring"),
            ];

            for (name, desc) in &teams {
                println!("  {:<16} {}", name, desc);
            }

            // Check for custom teams in vault
            let teams_dir = config.vault_path.join("_teams");
            if teams_dir.exists() {
                println!("\nCustom teams:");
                for entry in std::fs::read_dir(&teams_dir)? {
                    let entry = entry?;
                    if entry.path().is_dir() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        println!("  {}", name);
                    }
                }
            }
        }
        "run" => {
            let team = args
                .first()
                .ok_or_else(|| anyhow::anyhow!("Usage: hq teams run <team> <task>"))?;
            let task = if args.len() > 1 {
                args[1..].join(" ")
            } else {
                anyhow::bail!("Usage: hq teams run <team> \"<task description>\"");
            };

            println!("Dispatching to team: {}", team);
            println!("Task: {}\n", task);

            // Create a job targeted at the team
            let job = vault.create_job(&format!("[team:{}] {}", team, task), None)?;
            println!("Created job: {}", job.id);
            println!("The agent worker will pick this up and route to the {} team.", team);
        }
        _ => {
            println!("Usage: hq teams <subcommand>");
            println!();
            println!("Subcommands:");
            println!("  list              List available teams");
            println!("  run <team> <task> Run a task with a team");
        }
    }

    Ok(())
}
