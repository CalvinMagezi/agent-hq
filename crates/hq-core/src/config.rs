use figment::{
    Figment,
    providers::{Env, Format, Serialized, Yaml},
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Top-level HQ configuration, loaded from config file + env vars.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HqConfig {
    /// Path to the vault directory
    pub vault_path: PathBuf,

    /// OpenRouter API key
    pub openrouter_api_key: Option<String>,

    /// Anthropic API key (direct)
    pub anthropic_api_key: Option<String>,

    /// Google AI API key (direct)
    pub google_ai_api_key: Option<String>,

    /// Default LLM model for agent tasks
    #[serde(default = "default_model")]
    pub default_model: String,

    /// WebSocket server port for web UI
    #[serde(default = "default_ws_port")]
    pub ws_port: u16,

    /// Relay configuration
    #[serde(default)]
    pub relay: RelayConfig,

    /// Agent configuration
    #[serde(default)]
    pub agent: AgentConfig,

    /// Daemon configuration
    #[serde(default)]
    pub daemon: DaemonConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RelayConfig {
    pub discord_token: Option<String>,
    pub telegram_token: Option<String>,
    pub discord_enabled: bool,
    pub telegram_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Agent name (used in heartbeat, traces)
    #[serde(default = "default_agent_name")]
    pub name: String,

    /// Max concurrent jobs
    #[serde(default = "default_max_jobs")]
    pub max_concurrent_jobs: usize,

    /// Heartbeat interval in seconds
    #[serde(default = "default_heartbeat_secs")]
    pub heartbeat_interval_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonConfig {
    /// Embedding batch size
    #[serde(default = "default_embed_batch")]
    pub embedding_batch_size: usize,

    /// Embedding interval in seconds
    #[serde(default = "default_embed_interval")]
    pub embedding_interval_secs: u64,
}

fn default_model() -> String {
    "anthropic/claude-sonnet-4".to_string()
}

fn default_ws_port() -> u16 {
    5678
}

fn default_agent_name() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "hq-agent".to_string())
}

fn default_max_jobs() -> usize {
    1
}

fn default_heartbeat_secs() -> u64 {
    10
}

fn default_embed_batch() -> usize {
    10
}

fn default_embed_interval() -> u64 {
    600
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            name: default_agent_name(),
            max_concurrent_jobs: default_max_jobs(),
            heartbeat_interval_secs: default_heartbeat_secs(),
        }
    }
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            embedding_batch_size: default_embed_batch(),
            embedding_interval_secs: default_embed_interval(),
        }
    }
}

impl Default for HqConfig {
    fn default() -> Self {
        Self {
            vault_path: default_vault_path(),
            openrouter_api_key: None,
            anthropic_api_key: None,
            google_ai_api_key: None,
            default_model: default_model(),
            ws_port: default_ws_port(),
            relay: RelayConfig::default(),
            agent: AgentConfig::default(),
            daemon: DaemonConfig::default(),
        }
    }
}

fn default_vault_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".vault")
}

impl HqConfig {
    /// Load config from: defaults → config file → env vars
    pub fn load() -> anyhow::Result<Self> {
        let config_path = Self::config_file_path();

        let mut figment = Figment::from(Serialized::defaults(HqConfig::default()));

        if config_path.exists() {
            figment = figment.merge(Yaml::file(&config_path));
        }

        // HQ_VAULT_PATH, HQ_OPENROUTER_API_KEY, etc.
        figment = figment.merge(Env::prefixed("HQ_"));

        let config: HqConfig = figment.extract()?;
        Ok(config)
    }

    /// Path to the config file: ~/.hq/config.yaml
    pub fn config_file_path() -> PathBuf {
        Self::hq_dir().join("config.yaml")
    }

    /// HQ data directory: ~/.hq/
    pub fn hq_dir() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".hq")
    }

    /// Path to the SQLite database
    pub fn db_path(&self) -> PathBuf {
        self.vault_path.join("_data").join("vault.db")
    }
}
