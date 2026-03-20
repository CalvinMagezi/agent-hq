use anyhow::Result;
use hq_core::config::HqConfig;

/// Show or edit HQ configuration.
pub async fn run(config: &HqConfig, key: Option<&str>, value: Option<&str>) -> Result<()> {
    if let (Some(key), Some(value)) = (key, value) {
        // Set a config value
        set_config(key, value)?;
        println!("Set {} = {}", key, value);
        return Ok(());
    }

    if let Some(key) = key {
        // Show a specific key
        let val = get_config_value(config, key);
        println!("{}: {}", key, val);
        return Ok(());
    }

    // Show all config
    println!("Agent-HQ Configuration");
    println!("======================");
    println!();
    println!("Config file: {}", HqConfig::config_file_path().display());
    println!();
    println!("vault_path:        {}", config.vault_path.display());
    println!("default_model:     {}", config.default_model);
    println!("ws_port:           {}", config.ws_port);
    println!(
        "openrouter_api_key: {}",
        mask_key(&config.openrouter_api_key)
    );
    println!(
        "anthropic_api_key:  {}",
        mask_key(&config.anthropic_api_key)
    );
    println!(
        "google_ai_api_key:  {}",
        mask_key(&config.google_ai_api_key)
    );
    println!();
    println!("Agent:");
    println!("  name:                  {}", config.agent.name);
    println!("  max_concurrent_jobs:   {}", config.agent.max_concurrent_jobs);
    println!(
        "  heartbeat_interval:    {}s",
        config.agent.heartbeat_interval_secs
    );
    println!();
    println!("Relay:");
    println!("  discord_enabled:       {}", config.relay.discord_enabled);
    println!("  telegram_enabled:      {}", config.relay.telegram_enabled);
    println!(
        "  discord_token:         {}",
        mask_key(&config.relay.discord_token)
    );
    println!(
        "  telegram_token:        {}",
        mask_key(&config.relay.telegram_token)
    );
    println!();
    println!("Daemon:");
    println!(
        "  embedding_batch_size:  {}",
        config.daemon.embedding_batch_size
    );
    println!(
        "  embedding_interval:    {}s",
        config.daemon.embedding_interval_secs
    );

    Ok(())
}

fn mask_key(key: &Option<String>) -> String {
    match key {
        Some(k) if k.len() > 8 => format!("{}...", &k[..8]),
        Some(k) if !k.is_empty() => format!("{}...", k),
        _ => "(not set)".to_string(),
    }
}

fn get_config_value(config: &HqConfig, key: &str) -> String {
    match key {
        "vault_path" => config.vault_path.display().to_string(),
        "default_model" => config.default_model.clone(),
        "ws_port" => config.ws_port.to_string(),
        "openrouter_api_key" => mask_key(&config.openrouter_api_key),
        "anthropic_api_key" => mask_key(&config.anthropic_api_key),
        "google_ai_api_key" => mask_key(&config.google_ai_api_key),
        "agent.name" => config.agent.name.clone(),
        "agent.max_concurrent_jobs" => config.agent.max_concurrent_jobs.to_string(),
        "discord_enabled" => config.relay.discord_enabled.to_string(),
        "telegram_enabled" => config.relay.telegram_enabled.to_string(),
        _ => format!("(unknown key: {})", key),
    }
}

fn set_config(key: &str, value: &str) -> Result<()> {
    let config_path = HqConfig::config_file_path();
    let mut content = if config_path.exists() {
        std::fs::read_to_string(&config_path)?
    } else {
        String::new()
    };

    // Simple YAML key-value replacement or append
    let pattern = format!("{}: ", key);
    let new_line = format!("{}: \"{}\"", key, value);

    if let Some(pos) = content.find(&pattern) {
        // Replace existing line
        let line_end = content[pos..]
            .find('\n')
            .map(|i| pos + i)
            .unwrap_or(content.len());
        content.replace_range(pos..line_end, &new_line);
    } else {
        // Append
        if !content.ends_with('\n') && !content.is_empty() {
            content.push('\n');
        }
        content.push_str(&new_line);
        content.push('\n');
    }

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&config_path, content)?;

    Ok(())
}
