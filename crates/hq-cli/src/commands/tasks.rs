use anyhow::Result;
use hq_core::config::HqConfig;
use hq_vault::VaultClient;

/// List and manage tasks (sub-units of jobs delegated to harnesses).
pub async fn run(config: &HqConfig, sub: &str, args: &[String]) -> Result<()> {
    let vault = VaultClient::new(config.vault_path.clone())?;

    match sub {
        "list" | "ls" | "" => {
            println!("Tasks");
            println!("=====\n");

            for stage in &["pending", "claimed", "completed"] {
                let tasks = vault.list_tasks(stage)?;
                println!("  {} ({}): {}", stage, tasks.len(), if tasks.is_empty() { "none".to_string() } else { tasks.join(", ") });
            }
        }
        "create" | "new" => {
            if args.len() < 2 {
                anyhow::bail!("Usage: hq tasks create <job-id> \"<instruction>\" [--harness <type>]");
            }

            let job_id = &args[0];
            let mut instruction = String::new();
            let mut harness: Option<&str> = None;
            let mut i = 1;

            while i < args.len() {
                if args[i] == "--harness" && i + 1 < args.len() {
                    harness = Some(&args[i + 1]);
                    i += 2;
                } else {
                    if !instruction.is_empty() {
                        instruction.push(' ');
                    }
                    instruction.push_str(&args[i]);
                    i += 1;
                }
            }

            let task_id = format!("task-{}", uuid::Uuid::new_v4());
            vault.submit_task(job_id, &task_id, &instruction, harness)?;
            println!("Created task: {}", task_id);
            println!("Job: {}", job_id);
            if let Some(h) = harness {
                println!("Target harness: {}", h);
            }
        }
        "show" | "info" => {
            let task_id = args
                .first()
                .ok_or_else(|| anyhow::anyhow!("Usage: hq tasks show <task-id>"))?;
            match vault.get_task(task_id)? {
                Some(task) => {
                    println!("Task: {}", task.task_id);
                    println!("Job: {}", task.job_id);
                    println!("Status: {:?}", task.status);
                    println!("Created: {}", task.created_at);
                    println!();
                    println!("{}", task.instruction);
                    if let Some(result) = &task.result {
                        println!("\nResult:");
                        println!("{}", result);
                    }
                    if let Some(error) = &task.error {
                        println!("\nError:");
                        println!("{}", error);
                    }
                }
                None => println!("Task not found: {}", task_id),
            }
        }
        _ => {
            println!("Usage: hq tasks <subcommand>");
            println!();
            println!("Subcommands:");
            println!("  list                           List all tasks by stage");
            println!("  create <job-id> \"<instruction>\" Create a new task");
            println!("  show <task-id>                  Show task details");
        }
    }

    Ok(())
}
