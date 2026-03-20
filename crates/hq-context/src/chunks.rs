//! Note chunking, scoring, and LRU chunk cache.

use std::collections::HashMap;

use chrono::Utc;

use crate::tokenizer::count_tokens_fast;

/// A chunk of a vault note.
#[derive(Debug, Clone)]
pub struct NoteChunk {
    /// Source note path.
    pub note_path: String,
    /// Zero-based chunk index within the note.
    pub index: usize,
    /// The chunk text.
    pub text: String,
    /// Token count (heuristic).
    pub tokens: usize,
    /// Whether the source note is pinned.
    pub pinned: bool,
    /// Tags on the source note.
    pub tags: Vec<String>,
    /// Timestamp of last modification (ISO-8601).
    pub modified_at: Option<String>,
}

/// Split note content into chunks on paragraph boundaries (`\n\n+`).
///
/// Each chunk targets `target_size` tokens but will not split mid-paragraph.
pub fn chunk_note(
    content: &str,
    target_size: usize,
    note_path: &str,
    pinned: bool,
    tags: &[String],
    modified_at: Option<&str>,
) -> Vec<NoteChunk> {
    if content.is_empty() {
        return Vec::new();
    }

    let paragraphs: Vec<&str> = content.split("\n\n").collect();
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_tokens = 0usize;

    for para in &paragraphs {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        let para_tokens = count_tokens_fast(para);

        if current_tokens + para_tokens > target_size && !current.is_empty() {
            // Flush current chunk.
            chunks.push(NoteChunk {
                note_path: note_path.to_string(),
                index: chunks.len(),
                tokens: current_tokens,
                text: std::mem::take(&mut current),
                pinned,
                tags: tags.to_vec(),
                modified_at: modified_at.map(|s| s.to_string()),
            });
            current_tokens = 0;
        }

        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(para);
        current_tokens += para_tokens;
    }

    // Flush remaining.
    if !current.is_empty() {
        chunks.push(NoteChunk {
            note_path: note_path.to_string(),
            index: chunks.len(),
            tokens: current_tokens,
            text: current,
            pinned,
            tags: tags.to_vec(),
            modified_at: modified_at.map(|s| s.to_string()),
        });
    }

    chunks
}

/// Score chunks against a query and tags using a composite metric.
///
/// Returns chunks paired with their scores, sorted descending.
pub fn score_chunks(
    chunks: Vec<NoteChunk>,
    query: &str,
    context_tags: &[String],
) -> Vec<(NoteChunk, f64)> {
    let query_terms: Vec<String> = query
        .split_whitespace()
        .map(|t| t.to_lowercase())
        .collect();

    let now = Utc::now();

    let mut scored: Vec<(NoteChunk, f64)> = chunks
        .into_iter()
        .map(|chunk| {
            let score = compute_score(&chunk, &query_terms, context_tags, &now);
            (chunk, score)
        })
        .collect();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored
}

fn compute_score(
    chunk: &NoteChunk,
    query_terms: &[String],
    context_tags: &[String],
    now: &chrono::DateTime<Utc>,
) -> f64 {
    // 1. Relevance: matching terms / query terms (weight 0.5)
    let relevance = if query_terms.is_empty() {
        0.0
    } else {
        let lower = chunk.text.to_lowercase();
        let matches = query_terms
            .iter()
            .filter(|t| lower.contains(t.as_str()))
            .count();
        matches as f64 / query_terms.len() as f64
    };

    // 2. Recency: exp(-age_days / 7) (weight 0.2)
    let recency = chunk
        .modified_at
        .as_deref()
        .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
        .map(|dt| {
            let age_days = (*now - dt.with_timezone(&Utc))
                .num_seconds()
                .max(0) as f64
                / 86400.0;
            (-age_days / 7.0).exp()
        })
        .unwrap_or(0.0);

    // 3. Pin boost (weight 0.2)
    let pin_boost = if chunk.pinned { 1.0 } else { 0.0 };

    // 4. Tag match: intersection / max(len) (weight 0.1)
    let tag_match = if context_tags.is_empty() && chunk.tags.is_empty() {
        0.0
    } else {
        let max_len = context_tags.len().max(chunk.tags.len());
        if max_len == 0 {
            0.0
        } else {
            let intersect = context_tags
                .iter()
                .filter(|t| chunk.tags.contains(t))
                .count();
            intersect as f64 / max_len as f64
        }
    };

    relevance * 0.5 + recency * 0.2 + pin_boost * 0.2 + tag_match * 0.1
}

// ─── LRU Chunk Cache ───────────────────────────────────────────

/// Simple LRU cache for scored chunks, keyed by note path.
pub struct ChunkCache {
    entries: HashMap<String, CacheEntry>,
    order: Vec<String>,
    max_entries: usize,
}

struct CacheEntry {
    chunks: Vec<NoteChunk>,
}

impl ChunkCache {
    /// Create a new cache with the given max entry count.
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: Vec::new(),
            max_entries,
        }
    }

    /// Create a cache with the default max of 5000 entries.
    pub fn default_cache() -> Self {
        Self::new(5000)
    }

    /// Get cached chunks for a note path, if present.
    pub fn get(&mut self, note_path: &str) -> Option<&[NoteChunk]> {
        if self.entries.contains_key(note_path) {
            // Move to end (most recently used).
            self.order.retain(|k| k != note_path);
            self.order.push(note_path.to_string());
            Some(&self.entries[note_path].chunks)
        } else {
            None
        }
    }

    /// Insert chunks for a note path, evicting the LRU entry if at capacity.
    pub fn insert(&mut self, note_path: String, chunks: Vec<NoteChunk>) {
        if self.entries.contains_key(&note_path) {
            self.order.retain(|k| k != &note_path);
        } else if self.entries.len() >= self.max_entries {
            // Evict LRU.
            if let Some(evict_key) = self.order.first().cloned() {
                self.entries.remove(&evict_key);
                self.order.remove(0);
            }
        }
        self.order.push(note_path.clone());
        self.entries.insert(note_path, CacheEntry { chunks });
    }

    /// Number of cached entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the cache is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_splits_on_paragraphs() {
        let content = "para one\n\npara two\n\npara three";
        let chunks = chunk_note(content, 2, "test.md", false, &[], None);
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn empty_content_yields_no_chunks() {
        let chunks = chunk_note("", 100, "test.md", false, &[], None);
        assert!(chunks.is_empty());
    }

    #[test]
    fn cache_evicts_lru() {
        let mut cache = ChunkCache::new(2);
        cache.insert("a".to_string(), vec![]);
        cache.insert("b".to_string(), vec![]);
        cache.insert("c".to_string(), vec![]);
        assert_eq!(cache.len(), 2);
        assert!(cache.get("a").is_none());
        assert!(cache.get("b").is_some());
    }
}
