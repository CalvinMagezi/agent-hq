use serde::{Deserialize, Serialize};

/// Known model information for context window sizes and cost estimation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: &'static str,
    pub context_window: u32,
    pub input_cost_per_million: f64,
    pub output_cost_per_million: f64,
}

/// Get model info by ID. Returns None for unknown models.
pub fn get_model_info(model_id: &str) -> Option<ModelInfo> {
    KNOWN_MODELS.iter().find(|m| m.id == model_id).cloned()
}

/// Get the context window size for a model, defaulting to 128K if unknown.
pub fn context_window(model_id: &str) -> u32 {
    get_model_info(model_id)
        .map(|m| m.context_window)
        .unwrap_or(128_000)
}

static KNOWN_MODELS: &[ModelInfo] = &[
    ModelInfo {
        id: "anthropic/claude-sonnet-4",
        context_window: 200_000,
        input_cost_per_million: 3.0,
        output_cost_per_million: 15.0,
    },
    ModelInfo {
        id: "anthropic/claude-opus-4",
        context_window: 200_000,
        input_cost_per_million: 15.0,
        output_cost_per_million: 75.0,
    },
    ModelInfo {
        id: "anthropic/claude-haiku-4",
        context_window: 200_000,
        input_cost_per_million: 0.80,
        output_cost_per_million: 4.0,
    },
    ModelInfo {
        id: "google/gemini-2.5-pro",
        context_window: 1_000_000,
        input_cost_per_million: 1.25,
        output_cost_per_million: 10.0,
    },
    ModelInfo {
        id: "google/gemini-2.5-flash",
        context_window: 1_000_000,
        input_cost_per_million: 0.15,
        output_cost_per_million: 0.60,
    },
    ModelInfo {
        id: "openai/gpt-4.1",
        context_window: 1_000_000,
        input_cost_per_million: 2.0,
        output_cost_per_million: 8.0,
    },
    ModelInfo {
        id: "openai/o3",
        context_window: 200_000,
        input_cost_per_million: 2.0,
        output_cost_per_million: 8.0,
    },
];
