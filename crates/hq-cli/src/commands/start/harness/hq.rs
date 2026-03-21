//! HQ harness — OpenRouter LLM with cheap model fallback chain.

use anyhow::Result;

use super::super::common::resolve_model_alias;

/// HQ harness cheap model fallback chain.
pub const HQ_MODELS: &[&str] = &[
    "moonshotai/kimi-k2.5",
    "google/gemini-2.5-flash-lite",
    "minimax/minimax-m2.7",
];

/// Run the HQ harness (OpenRouter with cheap models, with fallback chain).
pub async fn run_hq_harness_stream(
    api_key: &str,
    messages: Vec<hq_core::types::ChatMessage>,
    model_override: Option<&str>,
) -> Result<(String, bool)> {
    use futures::StreamExt as _;
    use hq_llm::LlmProvider as _;

    // Build model list: override first, then fallback chain
    let models: Vec<String> = if let Some(ovr) = model_override {
        let resolved = resolve_model_alias(ovr);
        let mut v = vec![resolved];
        for m in HQ_MODELS {
            let s = m.to_string();
            if !v.contains(&s) {
                v.push(s);
            }
        }
        v
    } else {
        HQ_MODELS.iter().map(|s| s.to_string()).collect()
    };

    let provider = hq_llm::openrouter::OpenRouterProvider::new(api_key);

    for (i, model) in models.iter().enumerate() {
        let request = hq_llm::ChatRequest {
            model: model.clone(),
            messages: messages.clone(),
            tools: vec![],
            temperature: Some(0.7),
            max_tokens: Some(4096),
        };

        match provider.chat_stream(&request).await {
            Ok(mut stream) => {
                let mut accumulated = String::new();
                let mut stream_done = false;

                while let Some(chunk_result) = stream.next().await {
                    match chunk_result {
                        Ok(hq_llm::StreamChunk::Text(text)) => {
                            accumulated.push_str(&text);
                        }
                        Ok(hq_llm::StreamChunk::Done) => {
                            stream_done = true;
                            break;
                        }
                        Ok(_) => {}
                        Err(e) => {
                            tracing::warn!(
                                model = %model,
                                error = %e,
                                "HQ harness stream error, trying next model"
                            );
                            break;
                        }
                    }
                }

                if !accumulated.is_empty() || stream_done {
                    return Ok((accumulated, stream_done));
                }
            }
            Err(e) => {
                tracing::warn!(
                    model = %model,
                    attempt = i + 1,
                    error = %e,
                    "HQ harness model failed"
                );
                continue;
            }
        }
    }

    anyhow::bail!("All HQ models failed. Tried: {}", models.join(", "))
}
