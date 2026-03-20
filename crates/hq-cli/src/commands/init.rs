use anyhow::Result;
use hq_core::config::HqConfig;
use std::path::PathBuf;

/// Full setup wizard: scaffold vault, configure API keys, install services.
pub async fn run(
    vault_override: Option<String>,
    non_interactive: bool,
) -> Result<()> {
    println!("\nAgent-HQ Setup");
    println!("==============\n");

    // Determine vault path
    let vault_path = vault_override
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".vault")
        });

    println!("Vault path: {}\n", vault_path.display());

    // Step 1: Create vault directories
    println!("Step 1: Scaffolding vault...");

    let dirs = [
        "_system",
        "_jobs/pending",
        "_jobs/running",
        "_jobs/done",
        "_jobs/failed",
        "_delegation/pending",
        "_delegation/pending/claude-code",
        "_delegation/pending/opencode",
        "_delegation/pending/gemini-cli",
        "_delegation/pending/any",
        "_delegation/claimed",
        "_delegation/completed",
        "_delegation/relay-health",
        "_threads/active",
        "_threads/archived",
        "_approvals/pending",
        "_approvals/resolved",
        "_logs",
        "_usage/daily",
        "_embeddings",
        "_agent-sessions",
        "_moc",
        "_templates",
        "_data",
        "_orchestration",
        "_plans/active",
        "_plans/archive",
        "_teams",
        "_agents",
        "Notebooks/Memories",
        "Notebooks/Projects",
        "Notebooks/Daily Digest",
        "Notebooks/AI Intelligence",
        "Notebooks/Insights",
        "Notebooks/Diagrams",
    ];

    let mut created = 0;
    for dir in &dirs {
        let full = vault_path.join(dir);
        if !full.exists() {
            std::fs::create_dir_all(&full)?;
            created += 1;
        }
    }
    println!("  Created {} directories.", created);

    // Step 2: Seed system files
    println!("Step 2: Seeding system files...");

    let system_files = [
        ("_system/SOUL.md", "---\nnoteType: system-file\nfileName: soul\nversion: 1\npinned: true\n---\n# SOUL - Agent Identity\n\nYou are a personal AI assistant and knowledge management agent. You operate locally on the user's machine, managing a structured markdown vault as your knowledge base.\n\n## Core Principles\n\n1. **Knowledge-first**: Always check existing notes before creating new ones.\n2. **Structured thinking**: Use frontmatter metadata consistently.\n3. **Local-first**: All data stays on the local machine.\n"),
        ("_system/MEMORY.md", "---\nnoteType: system-file\nfileName: memory\nversion: 1\npinned: true\n---\n# Agent Memory\n\n## Key Facts\n\n_No facts stored yet._\n\n## Active Goals\n\n_No active goals._\n"),
        ("_system/PREFERENCES.md", "---\nnoteType: system-file\nfileName: preferences\nversion: 1\npinned: true\n---\n# User Preferences\n\n_No preferences configured yet._\n"),
        ("_system/HEARTBEAT.md", "---\nnoteType: system-file\nfileName: heartbeat\nversion: 1\nlastProcessed: null\n---\n# Heartbeat\n\nWrite actionable tasks here. The daemon processes this file every 2 minutes.\n\n## Pending Actions\n\n_No pending actions._\n"),
        ("_system/CONFIG.md", "---\nnoteType: system-file\nfileName: config\nversion: 1\npinned: false\n---\n# Configuration\n\n| Key | Value |\n|-----|-------|\n| DEFAULT_MODEL | anthropic/claude-sonnet-4 |\n| orchestration_mode | internal |\n"),
    ];

    let mut seeded = 0;
    for (path, content) in &system_files {
        let full = vault_path.join(path);
        if !full.exists() {
            std::fs::write(&full, content)?;
            seeded += 1;
        }
    }
    println!("  Seeded {} system files.", seeded);

    // Step 3: Create HQ config
    println!("Step 3: Writing config...");

    let hq_dir = HqConfig::hq_dir();
    std::fs::create_dir_all(&hq_dir)?;

    let config_path = HqConfig::config_file_path();
    if !config_path.exists() || non_interactive {
        let config_content = format!(
            "vault_path: \"{}\"\ndefault_model: \"anthropic/claude-sonnet-4\"\nws_port: 5678\n",
            vault_path.display()
        );
        std::fs::write(&config_path, config_content)?;
        println!("  Config: {}", config_path.display());
    } else {
        println!("  Config exists: {} (skipped)", config_path.display());
    }

    // Step 4: API keys (skip in non-interactive mode)
    if !non_interactive {
        println!("\nStep 4: API keys...");
        println!("  Run `hq env` to configure API keys interactively.");
    }

    println!(
        "\nSetup complete! Vault ready at {}\n\nNext steps:\n  hq env      — configure API keys\n  hq          — start chatting\n  hq health   — check system health\n  hq help     — see all commands\n",
        vault_path.display()
    );

    Ok(())
}
