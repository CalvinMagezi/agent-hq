use anyhow::Result;
use hq_core::config::HqConfig;
use hq_vault::VaultClient;

/// Run an orchestrated pipeline — discovery, planning, execution.
pub async fn run(
    config: &HqConfig,
    instruction: &str,
    dry_run: bool,
    single_step: bool,
) -> Result<()> {
    if instruction.is_empty() {
        anyhow::bail!("Usage: hq orchestrate \"<your task description>\"");
    }

    let vault = VaultClient::new(config.vault_path.clone())?;
    let vault_path = &config.vault_path;

    println!("\nHQ Orchestrator");
    println!("===============\n");
    println!("  Task:   {}", instruction);
    println!("  Vault:  {}", vault_path.display());
    println!("  Mode:   {}", if single_step { "single-step" } else { "multi-step" });

    // Phase 1: Create orchestration trace directory
    let trace_id = format!(
        "orch-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );
    let trace_dir = vault_path.join("_orchestration").join(&trace_id);
    std::fs::create_dir_all(&trace_dir)?;

    println!("  Trace:  {}\n", trace_dir.display());

    // Phase 2: Build context from vault
    println!("Phase 1: Gathering context...");

    let ctx = vault.get_system_context()?;
    let context_chars = ctx.soul.len() + ctx.memory.len() + ctx.preferences.len();
    println!(
        "  System context: {} chars ({} pinned notes)",
        context_chars,
        ctx.pinned_notes.len()
    );

    // Phase 3: Create job
    println!("Phase 2: Creating job...");

    let job = vault.create_job(instruction, Some(&config.default_model))?;
    println!("  Job: {}", job.id);

    // Write trace file
    let trace_content = format!(
        "---\ntraceId: \"{}\"\njobId: \"{}\"\ninstruction: |\n  {}\nmodel: \"{}\"\ndryRun: {}\nsingleStep: {}\ncreatedAt: \"{}\"\n---\n\n# Orchestration Trace: {}\n\n## Instruction\n\n{}\n\n## Context\n\n- Soul: {} chars\n- Memory: {} chars\n- Preferences: {} chars\n- Pinned notes: {}\n\n## Job\n\n- ID: {}\n- Model: {}\n",
        trace_id,
        job.id,
        instruction,
        config.default_model,
        dry_run,
        single_step,
        chrono::Utc::now().to_rfc3339(),
        trace_id,
        instruction,
        ctx.soul.len(),
        ctx.memory.len(),
        ctx.preferences.len(),
        ctx.pinned_notes.len(),
        job.id,
        config.default_model,
    );

    std::fs::write(trace_dir.join("trace.md"), trace_content)?;

    if dry_run {
        println!("\n--- Dry Run ---\n");
        println!("Job {} created but not executed.", job.id);
        println!("Trace: {}", trace_dir.display());
        println!("\nTo execute: hq orchestrate \"{}\"", instruction);
        return Ok(());
    }

    // Phase 4: Execution
    println!("Phase 3: Executing...\n");
    println!(
        "Job {} is in the pending queue.",
        job.id
    );
    println!("The agent worker will pick it up and execute it.");
    println!("Monitor progress: hq jobs show {}", job.id);
    println!("View logs: hq logs agent");
    println!("\nTrace: {}", trace_dir.display());

    Ok(())
}
