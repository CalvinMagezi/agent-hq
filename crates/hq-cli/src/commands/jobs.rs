use anyhow::Result;
use hq_core::config::HqConfig;
use hq_vault::VaultClient;

/// List, create, and manage jobs in the vault queue.
pub async fn run(config: &HqConfig, sub: &str, args: &[String]) -> Result<()> {
    let vault = VaultClient::new(config.vault_path.clone())?;

    match sub {
        "list" | "ls" | "" => {
            let counts = vault.get_job_counts()?;
            println!("Job Queue");
            println!("=========\n");
            println!(
                "  Pending:  {}",
                counts.pending
            );
            println!(
                "  Running:  {}",
                counts.running
            );
            println!("  Done:     {}", counts.done);
            println!(
                "  Failed:   {}",
                counts.failed
            );

            // List pending jobs
            let pending = vault.list_pending_jobs()?;
            if !pending.is_empty() {
                println!("\nPending jobs:");
                for job_id in &pending {
                    println!("  {}", job_id);
                }
            }
        }
        "create" | "new" => {
            if args.is_empty() {
                anyhow::bail!("Usage: hq jobs create \"<instruction>\" [--model <model>]");
            }

            let mut instruction = String::new();
            let mut model: Option<&str> = None;
            let mut i = 0;

            while i < args.len() {
                if args[i] == "--model" && i + 1 < args.len() {
                    model = Some(&args[i + 1]);
                    i += 2;
                } else {
                    if !instruction.is_empty() {
                        instruction.push(' ');
                    }
                    instruction.push_str(&args[i]);
                    i += 1;
                }
            }

            let job = vault.create_job(&instruction, model)?;
            println!("Created job: {}", job.id);
            println!("Status: pending");
            if let Some(m) = model {
                println!("Model: {}", m);
            }
        }
        "cancel" => {
            let job_id = args
                .first()
                .ok_or_else(|| anyhow::anyhow!("Usage: hq jobs cancel <job-id>"))?;
            vault.fail_job(job_id, "Cancelled by user")?;
            println!("Cancelled job: {}", job_id);
        }
        "show" | "info" => {
            let job_id = args
                .first()
                .ok_or_else(|| anyhow::anyhow!("Usage: hq jobs show <job-id>"))?;

            // Try to find the job in any stage
            for stage in &["pending", "running", "done", "failed"] {
                let path = format!("_jobs/{}/{}.md", stage, job_id);
                if vault.note_exists(&path) {
                    let note = vault.read_note(&path)?;
                    println!("Job: {}", job_id);
                    println!("Stage: {}", stage);
                    println!("---");
                    println!("{}", note.content);
                    return Ok(());
                }
            }
            println!("Job not found: {}", job_id);
        }
        _ => {
            println!("Usage: hq jobs <subcommand>");
            println!();
            println!("Subcommands:");
            println!("  list                   List all jobs and counts");
            println!("  create \"<instruction>\" Create a new job");
            println!("  cancel <job-id>        Cancel a pending job");
            println!("  show <job-id>          Show job details");
        }
    }

    Ok(())
}
