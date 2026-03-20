//! Thread store — persists conversation threads as JSON files in `.vault/_threads/`.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use hq_core::types::PlatformId;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// A single message within a thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMessage {
    pub role: String,
    pub content: String,
    pub timestamp: DateTime<Utc>,
}

/// A conversation thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thread {
    pub id: String,
    pub platform: PlatformId,
    pub title: String,
    pub active_harness: Option<String>,
    pub messages: Vec<ThreadMessage>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Manages thread storage on disk.
pub struct ThreadStore {
    threads_dir: PathBuf,
    /// In-memory cache of chat_id -> thread_id.
    chat_map: HashMap<String, String>,
}

impl ThreadStore {
    /// Create a new ThreadStore rooted at the given vault path.
    pub fn new(vault_path: &Path) -> Result<Self> {
        let threads_dir = vault_path.join("_threads");
        fs::create_dir_all(&threads_dir)
            .with_context(|| format!("Failed to create threads dir: {}", threads_dir.display()))?;

        let mut store = Self {
            threads_dir,
            chat_map: HashMap::new(),
        };
        store.load_index()?;
        Ok(store)
    }

    /// Load existing threads into the chat_map index.
    fn load_index(&mut self) -> Result<()> {
        let entries = fs::read_dir(&self.threads_dir)?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(data) = fs::read_to_string(&path) {
                    if let Ok(thread) = serde_json::from_str::<Thread>(&data) {
                        // Use the thread id as the chat_id mapping key
                        self.chat_map.insert(thread.id.clone(), thread.id.clone());
                    }
                }
            }
        }
        Ok(())
    }

    /// Get an existing thread or create a new one for the given chat_id.
    pub fn get_or_create(&mut self, chat_id: &str, platform: PlatformId) -> Result<Thread> {
        // Try to load existing thread
        let thread_path = self.thread_path(chat_id);
        if thread_path.exists() {
            let data = fs::read_to_string(&thread_path)?;
            let thread: Thread = serde_json::from_str(&data)?;
            return Ok(thread);
        }

        // Create new thread
        let now = Utc::now();
        let thread = Thread {
            id: chat_id.to_string(),
            platform,
            title: format!("Thread {}", &chat_id[..8.min(chat_id.len())]),
            active_harness: None,
            messages: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        self.save_thread(&thread)?;
        self.chat_map
            .insert(chat_id.to_string(), thread.id.clone());
        Ok(thread)
    }

    /// Add a message to a thread and persist.
    pub fn add_message(&mut self, thread_id: &str, role: &str, content: &str) -> Result<()> {
        let thread_path = self.thread_path(thread_id);
        let data = fs::read_to_string(&thread_path)
            .with_context(|| format!("Thread not found: {thread_id}"))?;
        let mut thread: Thread = serde_json::from_str(&data)?;

        thread.messages.push(ThreadMessage {
            role: role.to_string(),
            content: content.to_string(),
            timestamp: Utc::now(),
        });
        thread.updated_at = Utc::now();

        self.save_thread(&thread)?;
        Ok(())
    }

    /// Get the last N messages formatted as context string, respecting a rough token budget.
    pub fn get_context(&self, thread_id: &str, max_tokens: usize) -> Result<String> {
        let thread_path = self.thread_path(thread_id);
        if !thread_path.exists() {
            return Ok(String::new());
        }
        let data = fs::read_to_string(&thread_path)?;
        let thread: Thread = serde_json::from_str(&data)?;

        // Rough estimate: 4 chars ≈ 1 token
        let max_chars = max_tokens * 4;
        let mut result = Vec::new();
        let mut total_chars = 0;

        // Walk messages in reverse, take until budget exhausted
        for msg in thread.messages.iter().rev() {
            let line = format!("[{}]: {}", msg.role, msg.content);
            if total_chars + line.len() > max_chars && !result.is_empty() {
                break;
            }
            total_chars += line.len();
            result.push(line);
        }

        result.reverse();
        Ok(result.join("\n"))
    }

    /// Set the active harness for a thread.
    pub fn set_harness(&mut self, thread_id: &str, harness: Option<String>) -> Result<()> {
        let thread_path = self.thread_path(thread_id);
        let data = fs::read_to_string(&thread_path)?;
        let mut thread: Thread = serde_json::from_str(&data)?;
        thread.active_harness = harness;
        thread.updated_at = Utc::now();
        self.save_thread(&thread)?;
        Ok(())
    }

    /// List all thread IDs.
    pub fn list_threads(&self) -> Result<Vec<String>> {
        Ok(self.chat_map.keys().cloned().collect())
    }

    // --- Internal ---

    fn thread_path(&self, thread_id: &str) -> PathBuf {
        self.threads_dir.join(format!("{thread_id}.json"))
    }

    fn save_thread(&self, thread: &Thread) -> Result<()> {
        let path = self.thread_path(&thread.id);
        let data = serde_json::to_string_pretty(thread)?;
        fs::write(&path, data)?;
        Ok(())
    }
}
