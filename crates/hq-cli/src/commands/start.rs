use anyhow::Result;
use hq_core::config::HqConfig;

pub async fn run(_config: &HqConfig, component: &str) -> Result<()> {
    match component {
        "all" => {
            println!("Starting all HQ components...");
            println!("  Agent worker, Daemon, Relays, WebSocket server");
            // Phase 2+ will implement this
            println!("Not yet implemented — coming in Phase 2");
        }
        "agent" => {
            println!("Starting agent worker...");
            println!("Not yet implemented — coming in Phase 2");
        }
        "daemon" => {
            println!("Starting daemon...");
            println!("Not yet implemented — coming in Phase 4");
        }
        "relay" => {
            println!("Starting relay adapters...");
            println!("Not yet implemented — coming in Phase 5");
        }
        other => {
            println!("Unknown component: {}. Options: all, agent, daemon, relay", other);
        }
    }
    Ok(())
}
