use anyhow::Result;
use hq_core::config::HqConfig;
use std::io::{self, BufRead, Write};

/// Interactive API key setup.
pub async fn run(_config: &HqConfig) -> Result<()> {
    println!("\nAgent-HQ Environment Setup");
    println!("==========================\n");

    let config_path = HqConfig::config_file_path();
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    let mask = |key: &Option<String>| -> String {
        match key {
            Some(k) if k.len() > 8 => format!("{}...", &k[..8]),
            Some(k) if !k.is_empty() => format!("{}...", k),
            _ => "(not set)".to_string(),
        }
    };

    // 1. OpenRouter
    println!("1. OpenRouter API Key (routes to any model)");
    println!("   Get one at: https://openrouter.ai/keys");
    println!("   Current: {}", mask(&_config.openrouter_api_key));
    print!("   Enter key (or press Enter to skip): ");
    stdout.flush()?;
    let mut or_key = String::new();
    stdin.lock().read_line(&mut or_key)?;
    let or_key = or_key.trim().to_string();
    println!();

    // 2. Anthropic
    println!("2. Anthropic API Key (direct Claude access)");
    println!("   Get one at: https://console.anthropic.com/settings/keys");
    println!("   Current: {}", mask(&_config.anthropic_api_key));
    print!("   Enter key (or press Enter to skip): ");
    stdout.flush()?;
    let mut an_key = String::new();
    stdin.lock().read_line(&mut an_key)?;
    let an_key = an_key.trim().to_string();
    println!();

    // 3. Google AI
    println!("3. Google AI API Key (Gemini access)");
    println!("   Get one at: https://aistudio.google.com/apikey");
    println!("   Current: {}", mask(&_config.google_ai_api_key));
    print!("   Enter key (or press Enter to skip): ");
    stdout.flush()?;
    let mut google_key = String::new();
    stdin.lock().read_line(&mut google_key)?;
    let google_key = google_key.trim().to_string();
    println!();

    // 4. Default model
    println!("4. Default LLM Model");
    println!("   Current: {}", _config.default_model);
    print!("   Enter model ID (or press Enter to keep current): ");
    stdout.flush()?;
    let mut model = String::new();
    stdin.lock().read_line(&mut model)?;
    let model = model.trim().to_string();
    println!();

    // Build updated config
    let mut content = String::new();
    content.push_str(&format!(
        "vault_path: \"{}\"\n",
        _config.vault_path.display()
    ));

    let or_final = if !or_key.is_empty() {
        or_key
    } else {
        _config.openrouter_api_key.clone().unwrap_or_default()
    };
    if !or_final.is_empty() {
        content.push_str(&format!("openrouter_api_key: \"{}\"\n", or_final));
    }

    let an_final = if !an_key.is_empty() {
        an_key
    } else {
        _config.anthropic_api_key.clone().unwrap_or_default()
    };
    if !an_final.is_empty() {
        content.push_str(&format!("anthropic_api_key: \"{}\"\n", an_final));
    }

    let google_final = if !google_key.is_empty() {
        google_key
    } else {
        _config.google_ai_api_key.clone().unwrap_or_default()
    };
    if !google_final.is_empty() {
        content.push_str(&format!("google_ai_api_key: \"{}\"\n", google_final));
    }

    let model_final = if !model.is_empty() {
        model
    } else {
        _config.default_model.clone()
    };
    content.push_str(&format!("default_model: \"{}\"\n", model_final));
    content.push_str(&format!("ws_port: {}\n", _config.ws_port));

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&config_path, content)?;

    println!("Updated: {}\n", config_path.display());
    println!("Run `hq health` to verify, or `hq` to start chatting.\n");

    Ok(())
}
