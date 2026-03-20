use anyhow::Result;
use hq_core::config::HqConfig;
use hq_vault::VaultClient;

/// Show memory facts, edit memory, and manage system context.
pub async fn run(config: &HqConfig, sub: &str, args: &[String]) -> Result<()> {
    let vault = VaultClient::new(config.vault_path.clone())?;

    match sub {
        "show" | "" => {
            let memory = vault.read_system_file("MEMORY.md")?;
            if memory.is_empty() {
                println!("No memory stored yet.");
                println!("Memory is written to: {}", config.vault_path.join("_system/MEMORY.md").display());
            } else {
                println!("{}", memory);
            }
        }
        "facts" => {
            let memory = vault.read_system_file("MEMORY.md")?;
            if memory.is_empty() {
                println!("No memory stored yet.");
                return Ok(());
            }

            // Extract lines that look like facts (bullet points under headings)
            println!("Memory Facts");
            println!("============\n");

            let mut in_section = false;
            let mut section_name;

            for line in memory.lines() {
                if line.starts_with("## ") {
                    section_name = line[3..].trim().to_string();
                    in_section = true;
                    println!("\n{}:", section_name);
                } else if line.starts_with("# ") {
                    in_section = false;
                } else if in_section && (line.starts_with("- ") || line.starts_with("* ")) {
                    println!("  {}", line);
                }
            }
        }
        "add" => {
            if args.is_empty() {
                anyhow::bail!("Usage: hq memory add \"<fact>\"");
            }
            let fact = args.join(" ");
            let mut memory = vault.read_system_file("MEMORY.md")?;

            if memory.is_empty() {
                memory = "---\nnoteType: system-file\nfileName: memory\nversion: 1\npinned: true\n---\n# Agent Memory\n\n## Key Facts\n\n".to_string();
            }

            // Add the fact under Key Facts section
            if let Some(pos) = memory.find("## Key Facts") {
                let insert_pos = memory[pos..]
                    .find("\n\n")
                    .map(|i| pos + i)
                    .unwrap_or(memory.len());
                let new_line = format!("\n- {}", fact);
                memory.insert_str(insert_pos, &new_line);
            } else {
                memory.push_str(&format!("\n- {}\n", fact));
            }

            vault.write_system_file("MEMORY.md", &memory)?;
            println!("Added to memory: {}", fact);
        }
        "soul" => {
            let soul = vault.read_system_file("SOUL.md")?;
            if soul.is_empty() {
                println!("No soul file yet. Run `hq setup` to create one.");
            } else {
                println!("{}", soul);
            }
        }
        "preferences" | "prefs" => {
            let prefs = vault.read_system_file("PREFERENCES.md")?;
            if prefs.is_empty() {
                println!("No preferences set yet.");
            } else {
                println!("{}", prefs);
            }
        }
        "context" => {
            let ctx = vault.get_system_context()?;
            println!("System Context Summary");
            println!("======================\n");
            println!("SOUL:        {} chars", ctx.soul.len());
            println!("MEMORY:      {} chars", ctx.memory.len());
            println!("PREFERENCES: {} chars", ctx.preferences.len());
            println!("HEARTBEAT:   {} chars", ctx.heartbeat.len());
            println!("Config keys: {}", ctx.config.len());
            println!("Pinned notes: {}", ctx.pinned_notes.len());

            if !ctx.pinned_notes.is_empty() {
                println!("\nPinned:");
                for note in &ctx.pinned_notes {
                    println!("  - {} ({})", note.title, note.path);
                }
            }
        }
        _ => {
            println!("Usage: hq memory <subcommand>");
            println!();
            println!("Subcommands:");
            println!("  show             Show full MEMORY.md");
            println!("  facts            Extract memory facts");
            println!("  add \"<fact>\"     Add a fact to memory");
            println!("  soul             Show SOUL.md");
            println!("  preferences      Show PREFERENCES.md");
            println!("  context          Show system context summary");
        }
    }

    Ok(())
}
