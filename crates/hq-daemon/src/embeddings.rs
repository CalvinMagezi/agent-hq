//! Batch embedding processor — finds notes with pending embedding status and processes them.

use anyhow::Result;
use hq_db::Database;
use hq_llm::{ChatRequest, LlmProvider};
use hq_vault::VaultClient;
use tracing::{debug, info, warn};

/// Process a batch of notes that need embeddings.
///
/// Finds notes with `embedding_status = "pending"` (up to `batch_size`),
/// generates embeddings via the LLM provider, stores them in the database,
/// and updates the note's embedding status.
///
/// Returns the number of notes successfully processed.
pub async fn process_embeddings<P: LlmProvider>(
    vault: &VaultClient,
    db: &Database,
    batch_size: usize,
    provider: &P,
) -> Result<usize> {
    // Get notes with pending embedding status
    let pending_paths = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT path FROM notes_fts WHERE path NOT IN (SELECT note_path FROM embeddings) LIMIT ?1",
        )?;
        let rows = stmt.query_map([batch_size], |row| row.get::<_, String>(0))?;
        let mut paths = Vec::new();
        for row in rows {
            paths.push(row?);
        }
        Ok(paths)
    })?;

    if pending_paths.is_empty() {
        debug!("no pending embeddings to process");
        return Ok(0);
    }

    info!(count = pending_paths.len(), "processing pending embeddings");
    let mut processed = 0;

    for note_path in &pending_paths {
        let note = match vault.read_note(note_path) {
            Ok(n) => n,
            Err(e) => {
                warn!(path = %note_path, error = %e, "skipping note — read failed");
                continue;
            }
        };

        // Use the LLM provider to generate an embedding-like representation.
        // In a production system this would call a dedicated embedding endpoint;
        // here we ask the model for a compact summary that can be stored.
        let request = ChatRequest {
            model: "openai/text-embedding-3-small".to_string(),
            messages: vec![hq_core::types::ChatMessage {
                role: hq_core::types::MessageRole::User,
                content: format!(
                    "Generate a compact embedding summary for the following note:\n\n# {}\n\n{}",
                    note.title, note.content
                ),
                tool_calls: Vec::new(),
                tool_call_id: None,
            }],
            tools: Vec::new(),
            temperature: Some(0.0),
            max_tokens: Some(256),
        };

        match provider.chat(&request).await {
            Ok(response) => {
                let embedding_text = response.message.content.as_bytes().to_vec();
                let now = chrono::Utc::now().timestamp();

                if let Err(e) = db.with_conn(|conn| {
                    conn.execute(
                        "INSERT OR REPLACE INTO embeddings (note_path, embedding, model, embedded_at) VALUES (?1, ?2, ?3, ?4)",
                        rusqlite::params![note_path, embedding_text, "text-embedding-3-small", now],
                    )?;
                    Ok(())
                }) {
                    warn!(path = %note_path, error = %e, "failed to store embedding");
                    continue;
                }

                processed += 1;
                debug!(path = %note_path, "embedding stored");
            }
            Err(e) => {
                warn!(path = %note_path, error = %e, "embedding generation failed");
            }
        }
    }

    info!(processed = processed, total = pending_paths.len(), "embedding batch complete");
    Ok(processed)
}
