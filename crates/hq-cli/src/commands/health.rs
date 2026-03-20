use anyhow::Result;
use hq_core::config::HqConfig;
use hq_vault::VaultClient;
use std::process::Command;

/// System health check — diagnose common issues.
pub async fn run(config: &HqConfig) -> Result<()> {
    println!("\nAgent-HQ Health Check");
    println!("=====================\n");

    let mut issues = 0;

    // 1. Vault exists & scaffolded
    let vault_path = &config.vault_path;
    if vault_path.join("_system/SOUL.md").exists() {
        ok(&format!("Vault scaffolded at {}", vault_path.display()));
    } else if vault_path.exists() {
        fail(&format!(
            "Vault exists at {} but not scaffolded — run: hq setup",
            vault_path.display()
        ));
        issues += 1;
    } else {
        fail(&format!(
            "No vault found at {} — run: hq setup",
            vault_path.display()
        ));
        issues += 1;
    }

    // 2. Config file
    let config_path = HqConfig::config_file_path();
    if config_path.exists() {
        ok(&format!("Config: {}", config_path.display()));
    } else {
        fail("Config file not found — run: hq setup");
        issues += 1;
    }

    // 3. API keys
    let has_openrouter = config.openrouter_api_key.as_ref().is_some_and(|k| !k.is_empty());
    let has_anthropic = config.anthropic_api_key.as_ref().is_some_and(|k| !k.is_empty());
    let has_google = config.google_ai_api_key.as_ref().is_some_and(|k| !k.is_empty());

    let mut keys = Vec::new();
    if has_openrouter {
        keys.push("OpenRouter");
    }
    if has_anthropic {
        keys.push("Anthropic");
    }
    if has_google {
        keys.push("Google AI");
    }

    if !keys.is_empty() {
        ok(&format!("API keys configured ({})", keys.join(" + ")));
    } else {
        warn("No LLM API keys set — configure in ~/.hq/config.yaml or set HQ_OPENROUTER_API_KEY");
    }

    // 4. Database
    let db_path = config.db_path();
    if db_path.exists() {
        let size = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
        ok(&format!("Database: {:.1} MB", size as f64 / 1_048_576.0));
    } else {
        warn("Database not initialized (run hq setup)");
    }

    // 5. Vault stats
    if vault_path.exists() {
        match VaultClient::new(vault_path.clone()) {
            Ok(vault) => {
                if let Ok(stats) = vault.get_stats() {
                    ok(&format!("Notes: {}", stats.total_notes));
                    ok(&format!(
                        "Jobs: {} pending, {} running, {} done, {} failed",
                        stats.total_jobs.pending,
                        stats.total_jobs.running,
                        stats.total_jobs.done,
                        stats.total_jobs.failed
                    ));
                }
            }
            Err(e) => {
                fail(&format!("Could not read vault: {}", e));
                issues += 1;
            }
        }
    }

    // 6. CLI tools
    println!();
    check_tool("claude", "Claude CLI");
    check_tool("gemini", "Gemini CLI");
    check_tool("opencode", "OpenCode CLI");

    // 7. Key ports
    println!();
    for (port, label) in [(5678, "Agent WS"), (18900, "Relay Server"), (4747, "PWA")] {
        if is_port_in_use(port) {
            ok(&format!("Port {} ({}) in use — service likely running", port, label));
        } else {
            dim(&format!("Port {} ({}) available", port, label));
        }
    }

    // 8. MCP
    println!();
    let claude_config = dirs::home_dir()
        .unwrap_or_default()
        .join("Library/Application Support/Claude/claude_desktop_config.json");
    if claude_config.exists() {
        if let Ok(content) = std::fs::read_to_string(&claude_config) {
            if content.contains("agent-hq") {
                ok("MCP server configured for Claude Desktop");
            } else {
                warn("Claude Desktop config exists but agent-hq MCP not configured — run: hq mcp");
            }
        }
    }

    // Summary
    println!();
    if issues == 0 {
        println!("All checks passed. Run `hq` to start chatting.\n");
    } else {
        println!(
            "{} issue(s) found. Fix the items above and re-run `hq health`.\n",
            issues
        );
    }

    Ok(())
}

fn check_tool(cmd: &str, label: &str) {
    match Command::new(cmd).arg("--version").output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_string();
            ok(&format!("{}: {}", label, version));
        }
        _ => {
            dim(&format!("{}: not installed (optional)", label));
        }
    }
}

fn is_port_in_use(port: u16) -> bool {
    #[cfg(unix)]
    {
        Command::new("lsof")
            .args(["-i", &format!(":{}", port), "-sTCP:LISTEN", "-t"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn ok(msg: &str) {
    println!("  [OK]   {}", msg);
}

fn fail(msg: &str) {
    println!("  [FAIL] {}", msg);
}

fn warn(msg: &str) {
    println!("  [WARN] {}", msg);
}

fn dim(msg: &str) {
    println!("  [----] {}", msg);
}
