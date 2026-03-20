use anyhow::Result;
use hq_core::config::HqConfig;
use serde_json::{json, Value};
use std::path::PathBuf;

/// Install, check, or remove HQ MCP server configuration.
pub async fn run(config: &HqConfig, sub: &str) -> Result<()> {
    match sub {
        "install" | "" => install(config).await,
        "status" => status(config).await,
        "remove" => remove().await,
        _ => {
            println!("Usage: hq mcp [install|status|remove]");
            Ok(())
        }
    }
}

async fn install(config: &HqConfig) -> Result<()> {
    println!("Installing HQ MCP server configuration...\n");

    let hq_binary = std::env::current_exe()?;

    let mcp_server = json!({
        "command": hq_binary.to_string_lossy(),
        "args": ["mcp-serve"],
        "env": {
            "HQ_VAULT_PATH": config.vault_path.to_string_lossy(),
        }
    });

    // Claude Desktop config
    let claude_config_paths = get_claude_config_paths();
    let mut installed_to = Vec::new();

    for config_path in &claude_config_paths {
        if let Some(parent) = config_path.parent() {
            if parent.exists() {
                match install_to_config(config_path, "agent-hq", &mcp_server) {
                    Ok(()) => {
                        installed_to.push(config_path.display().to_string());
                    }
                    Err(e) => {
                        eprintln!("  Warning: Could not update {}: {}", config_path.display(), e);
                    }
                }
            }
        }
    }

    // VS Code settings
    let vscode_paths = get_vscode_settings_paths();
    for settings_path in &vscode_paths {
        if settings_path.exists() {
            match install_to_vscode(settings_path, "agent-hq", &mcp_server) {
                Ok(()) => {
                    installed_to.push(settings_path.display().to_string());
                }
                Err(e) => {
                    eprintln!(
                        "  Warning: Could not update {}: {}",
                        settings_path.display(),
                        e
                    );
                }
            }
        }
    }

    if installed_to.is_empty() {
        println!("No supported AI editor configs found.");
        println!("Manually add the MCP server to your editor config:");
        println!();
        println!("{}", serde_json::to_string_pretty(&mcp_server)?);
    } else {
        for path in &installed_to {
            println!("  Installed to: {}", path);
        }
        println!("\nMCP server configured for {} editor(s).", installed_to.len());
    }

    Ok(())
}

async fn status(_config: &HqConfig) -> Result<()> {
    println!("MCP Server Status");
    println!("=================\n");

    let claude_paths = get_claude_config_paths();
    for path in &claude_paths {
        let label = if path.to_string_lossy().contains("Code") {
            "Claude Desktop (VS Code)"
        } else {
            "Claude Desktop"
        };

        if path.exists() {
            let content = std::fs::read_to_string(path)?;
            if content.contains("agent-hq") {
                println!("  {}: installed", label);
            } else {
                println!("  {}: config exists, but agent-hq not configured", label);
            }
        } else {
            println!("  {}: not found", label);
        }
    }

    let vscode_paths = get_vscode_settings_paths();
    for path in &vscode_paths {
        if path.exists() {
            let content = std::fs::read_to_string(path)?;
            if content.contains("agent-hq") {
                println!("  VS Code: installed");
            } else {
                println!("  VS Code: settings exist, but agent-hq MCP not configured");
            }
        }
    }

    Ok(())
}

async fn remove() -> Result<()> {
    println!("Removing HQ MCP server from all configs...\n");

    let claude_paths = get_claude_config_paths();
    for path in &claude_paths {
        if path.exists() {
            if let Ok(mut config) = read_json(path) {
                if let Some(servers) = config
                    .get_mut("mcpServers")
                    .and_then(|v| v.as_object_mut())
                {
                    if servers.remove("agent-hq").is_some() {
                        write_json(path, &config)?;
                        println!("  Removed from: {}", path.display());
                    }
                }
            }
        }
    }

    println!("\nDone.");
    Ok(())
}

fn get_claude_config_paths() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut paths = Vec::new();

    if cfg!(target_os = "macos") {
        paths.push(
            home.join("Library/Application Support/Claude/claude_desktop_config.json"),
        );
    } else if cfg!(target_os = "linux") {
        paths.push(home.join(".config/claude/claude_desktop_config.json"));
    } else if cfg!(target_os = "windows") {
        if let Some(appdata) = dirs::config_dir() {
            paths.push(appdata.join("Claude/claude_desktop_config.json"));
        }
    }

    // Also check .claude/settings.json (newer Claude Code format)
    paths.push(home.join(".claude/settings.json"));

    paths
}

fn get_vscode_settings_paths() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut paths = Vec::new();

    if cfg!(target_os = "macos") {
        paths.push(
            home.join("Library/Application Support/Code/User/settings.json"),
        );
    } else if cfg!(target_os = "linux") {
        paths.push(home.join(".config/Code/User/settings.json"));
    }

    paths
}

fn read_json(path: &PathBuf) -> Result<Value> {
    let content = std::fs::read_to_string(path)?;
    let value: Value = serde_json::from_str(&content)?;
    Ok(value)
}

fn write_json(path: &PathBuf, value: &Value) -> Result<()> {
    let content = serde_json::to_string_pretty(value)?;
    std::fs::write(path, content)?;
    Ok(())
}

fn install_to_config(path: &PathBuf, name: &str, server: &Value) -> Result<()> {
    let mut config = if path.exists() {
        read_json(path)?
    } else {
        json!({})
    };

    let servers = config
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("config is not an object"))?
        .entry("mcpServers")
        .or_insert_with(|| json!({}));

    servers
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("mcpServers is not an object"))?
        .insert(name.to_string(), server.clone());

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_json(path, &config)?;

    Ok(())
}

fn install_to_vscode(path: &PathBuf, name: &str, server: &Value) -> Result<()> {
    let mut settings = read_json(path)?;

    let mcp_key = "mcp.servers";
    let servers = settings
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("settings is not an object"))?
        .entry(mcp_key)
        .or_insert_with(|| json!({}));

    servers
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("{} is not an object", mcp_key))?
        .insert(name.to_string(), server.clone());

    write_json(path, &settings)?;

    Ok(())
}
