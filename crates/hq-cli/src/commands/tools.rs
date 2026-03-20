use anyhow::Result;
use hq_core::config::HqConfig;
use std::process::Command;

/// Check, install, and authenticate CLI tools (Claude, Gemini, OpenCode).
pub async fn run(_config: &HqConfig) -> Result<()> {
    println!("\nCLI Tools Setup");
    println!("===============\n");

    // Claude CLI
    println!("── Claude CLI ──");
    match Command::new("claude").arg("--version").output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            println!("  [OK] Claude CLI: {}", version);
        }
        _ => {
            println!("  [--] Claude CLI: not installed");
            println!("       Install: npm install -g @anthropic-ai/claude-code");
        }
    }

    // Gemini CLI
    println!("\n── Gemini CLI ──");
    match Command::new("gemini").arg("--version").output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            println!("  [OK] Gemini CLI: {}", version);
        }
        _ => {
            println!("  [--] Gemini CLI: not installed (optional)");
            println!("       Install: npm install -g @google/gemini-cli");
        }
    }

    // OpenCode
    println!("\n── OpenCode ──");
    match Command::new("opencode").arg("--version").output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            println!("  [OK] OpenCode: {}", version);
        }
        _ => {
            println!("  [--] OpenCode: not installed (optional)");
            println!("       Install: npm install -g opencode");
        }
    }

    // DrawIt
    println!("\n── DrawIt CLI ──");
    match Command::new("drawit").arg("--version").output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            println!("  [OK] DrawIt: {}", version);
        }
        _ => {
            println!("  [--] DrawIt: not installed (optional, for diagrams)");
            println!("       Install: npm install -g @chamuka-labs/drawit-cli");
        }
    }

    // Bun
    println!("\n── Bun ──");
    match Command::new("bun").arg("--version").output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            println!("  [OK] Bun: {}", version);
        }
        _ => {
            println!("  [--] Bun: not installed");
            println!("       Install: https://bun.sh");
        }
    }

    println!();
    Ok(())
}
