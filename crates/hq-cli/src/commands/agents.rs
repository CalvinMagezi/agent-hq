use anyhow::Result;
use hq_core::config::HqConfig;
use hq_vault::VaultClient;

/// List and inspect agent definitions from vault.
pub async fn run(config: &HqConfig, sub: &str, args: &[String]) -> Result<()> {
    let vault = VaultClient::new(config.vault_path.clone())?;

    match sub {
        "list" | "ls" | "" => {
            println!("Agent Definitions");
            println!("=================\n");

            // Scan agents/ directories in the vault and in known package paths
            let agents_dirs = vec![
                ("vault", config.vault_path.join("_agents")),
            ];

            let mut found = 0;

            for (source, dir) in &agents_dirs {
                if !dir.exists() {
                    continue;
                }

                for entry in std::fs::read_dir(dir)? {
                    let entry = entry?;
                    let path = entry.path();
                    if path.extension().is_some_and(|ext| ext == "md") {
                        let name = path
                            .file_stem()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();

                        // Quick frontmatter scan
                        if let Ok(content) = std::fs::read_to_string(&path) {
                            let vertical = extract_fm_value(&content, "vertical")
                                .unwrap_or_else(|| "general".to_string());
                            let role = extract_fm_value(&content, "baseRole")
                                .unwrap_or_else(|| "agent".to_string());
                            let harness = extract_fm_value(&content, "preferredHarness")
                                .unwrap_or_else(|| "any".to_string());

                            println!(
                                "  {} ({}) — role: {}, harness: {} [{}]",
                                name, vertical, role, harness, source
                            );
                            found += 1;
                        }
                    }
                }
            }

            // Also list built-in agent verticals
            println!("\n  Built-in verticals:");
            for vertical in &["engineering", "qa", "research", "content", "ops"] {
                println!("    {}", vertical);
            }

            if found == 0 {
                println!("\n  No custom agent definitions found in vault.");
                println!("  Create agents in: {}", config.vault_path.join("_agents").display());
            }

            println!("\n  Total custom agents: {}", found);
        }
        "show" | "info" => {
            let name = args
                .first()
                .ok_or_else(|| anyhow::anyhow!("Usage: hq agents show <name>"))?;
            let path = format!("_agents/{}.md", name);

            if vault.note_exists(&path) {
                let note = vault.read_note(&path)?;
                println!("Agent: {}\n", note.title);
                println!("{}", note.content);
            } else {
                println!("Agent not found: {}", name);
                println!("Available agents: hq agents list");
            }
        }
        _ => {
            println!("Usage: hq agents <subcommand>");
            println!();
            println!("Subcommands:");
            println!("  list              List all agent definitions");
            println!("  show <name>       Show agent details");
        }
    }

    Ok(())
}

fn extract_fm_value(content: &str, key: &str) -> Option<String> {
    if !content.starts_with("---") {
        return None;
    }
    let end = content[3..].find("---")?;
    let fm = &content[3..3 + end];
    for line in fm.lines() {
        if let Some(rest) = line.strip_prefix(&format!("{}: ", key)) {
            return Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    None
}
