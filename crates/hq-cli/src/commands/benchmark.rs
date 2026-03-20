use anyhow::Result;
use hq_core::config::HqConfig;
use std::time::Instant;

/// Run a basic model benchmark — latency, throughput for configured models.
pub async fn run(config: &HqConfig, model_override: Option<&str>) -> Result<()> {
    let api_key = config
        .openrouter_api_key
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("OpenRouter API key not set. Run `hq setup` or set HQ_OPENROUTER_API_KEY"))?;

    let model = model_override.unwrap_or(&config.default_model);

    println!("Model Benchmark");
    println!("===============\n");
    println!("Model: {}", model);
    println!("Provider: OpenRouter\n");

    let prompt = "Respond with exactly: 'Hello, World!' — nothing else.";

    println!("Running benchmark (3 iterations)...\n");

    let mut latencies = Vec::new();

    for i in 1..=3 {
        print!("  Run {}/3... ", i);
        let start = Instant::now();

        let client = reqwest::Client::new();
        let response = client
            .post("https://openrouter.ai/api/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 20,
            }))
            .send()
            .await?;

        let elapsed = start.elapsed();
        let status = response.status();

        if status.is_success() {
            let body: serde_json::Value = response.json().await?;
            let reply = body["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("(no content)");
            let tokens = body["usage"]["total_tokens"].as_u64().unwrap_or(0);

            println!(
                "{:.0}ms — {} tokens — \"{}\"",
                elapsed.as_millis(),
                tokens,
                reply.trim()
            );
            latencies.push(elapsed.as_millis() as f64);
        } else {
            let error = response.text().await?;
            println!("FAILED ({}): {}", status, error);
        }
    }

    if !latencies.is_empty() {
        let avg = latencies.iter().sum::<f64>() / latencies.len() as f64;
        let min = latencies.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = latencies.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

        println!("\nResults:");
        println!("  Avg latency:  {:.0}ms", avg);
        println!("  Min latency:  {:.0}ms", min);
        println!("  Max latency:  {:.0}ms", max);
    }

    Ok(())
}
