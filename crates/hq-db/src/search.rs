//! Full search client — FTS5 keyword search, vector embeddings, cosine similarity,
//! hybrid search, graph links, and link state tracking.
//!
//! Port of the TypeScript `SearchClient` from `packages/vault-client/src/search.ts`.

use std::collections::HashMap;

use anyhow::Result;
use rusqlite::Connection;

use hq_core::types::{GraphLink, LinkState, MatchType, SearchResult, SearchStats};

// ─── Cosine Similarity (pure Rust, no external crate) ────────────────────────

/// Compute cosine similarity between two vectors.
/// Returns 0.0 if either vector has zero magnitude.
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        0.0
    } else {
        dot / (norm_a * norm_b)
    }
}

/// Batch cosine similarity: `matrix` is a flattened row-major matrix of embeddings,
/// each row has `dim` elements. Returns one similarity score per row.
fn batch_cosine_similarity(query: &[f32], matrix: &[f32], dim: usize) -> Vec<f32> {
    matrix
        .chunks(dim)
        .map(|row| cosine_similarity(query, row))
        .collect()
}

// ─── Embedding Serialization Helpers ─────────────────────────────────────────

/// Serialize `&[f32]` to bytes (little-endian, matching JS Float32Array layout).
fn embedding_to_bytes(embedding: &[f32]) -> Vec<u8> {
    embedding
        .iter()
        .flat_map(|f| f.to_le_bytes())
        .collect()
}

/// Deserialize bytes back to `Vec<f32>`.
fn bytes_to_embedding(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

// ─── FTS5 Query Sanitization ─────────────────────────────────────────────────

/// Escape special FTS5 characters so user input doesn't break MATCH queries.
fn sanitize_fts_query(query: &str) -> String {
    let escaped: String = query
        .chars()
        .map(|c| {
            if "'\"){}[]*+^~!@#$%&:.,-".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    // Collapse whitespace
    escaped.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extract notebook name from a relative note path (e.g. "Notebooks/Projects/foo.md" -> "Projects").
fn notebook_from_path(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() > 1 {
        parts[1].to_string()
    } else {
        "Unknown".to_string()
    }
}

/// Extract a title from a file path (basename without .md extension).
fn title_from_path(path: &str) -> String {
    let basename = path.rsplit('/').next().unwrap_or(path);
    basename.strip_suffix(".md").unwrap_or(basename).to_string()
}

// ─── Index Operations ────────────────────────────────────────────────────────

/// Index a note into FTS5 for full-text search.
/// Performs DELETE + INSERT (FTS5 doesn't support UPSERT).
pub fn index_note(
    conn: &Connection,
    path: &str,
    title: &str,
    content: &str,
    tags: &str,
) -> Result<()> {
    conn.execute("DELETE FROM notes_fts WHERE path = ?1", [path])?;
    conn.execute(
        "INSERT INTO notes_fts (path, title, content, tags) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![path, title, content, tags],
    )?;
    Ok(())
}

/// Remove a note from both FTS index and embeddings table.
pub fn remove_note(conn: &Connection, path: &str) -> Result<()> {
    conn.execute("DELETE FROM notes_fts WHERE path = ?1", [path])?;
    conn.execute("DELETE FROM embeddings WHERE note_path = ?1", [path])?;
    Ok(())
}

/// Get total number of FTS-indexed notes.
pub fn indexed_count(conn: &Connection) -> Result<usize> {
    let count: usize =
        conn.query_row("SELECT COUNT(*) FROM notes_fts", [], |row| row.get(0))?;
    Ok(count)
}

// ─── Embedding Storage ───────────────────────────────────────────────────────

/// Store (or replace) an embedding for a note.
pub fn store_embedding(
    conn: &Connection,
    path: &str,
    embedding: &[f32],
    model: &str,
) -> Result<()> {
    let blob = embedding_to_bytes(embedding);
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR REPLACE INTO embeddings (note_path, embedding, model, embedded_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![path, blob, model, now],
    )?;
    Ok(())
}

/// Retrieve the stored embedding for a note. Returns `None` if not found.
pub fn get_embedding(conn: &Connection, path: &str) -> Result<Option<Vec<f32>>> {
    let mut stmt =
        conn.prepare("SELECT embedding FROM embeddings WHERE note_path = ?1")?;
    let result = stmt.query_row([path], |row| {
        let blob: Vec<u8> = row.get(0)?;
        Ok(blob)
    });
    match result {
        Ok(blob) => Ok(Some(bytes_to_embedding(&blob))),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Get all note paths that have stored embeddings.
pub fn get_embedded_note_paths(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT note_path FROM embeddings")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut paths = Vec::new();
    for row in rows {
        paths.push(row?);
    }
    Ok(paths)
}

// ─── Keyword Search ──────────────────────────────────────────────────────────

/// Full-text keyword search using FTS5 MATCH with snippets.
/// Returns results sorted by FTS5 rank (most relevant first).
pub fn keyword_search(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchResult>> {
    let escaped = sanitize_fts_query(query);
    if escaped.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt = conn.prepare(
        "SELECT path, title, snippet(notes_fts, 2, '<mark>', '</mark>', '...', 30) as snippet,
                tags, rank
         FROM notes_fts
         WHERE notes_fts MATCH ?1
         ORDER BY rank
         LIMIT ?2",
    )?;

    let rows = stmt.query_map(rusqlite::params![escaped, limit], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, f64>(4)?,
        ))
    })?;

    let mut results = Vec::new();
    for row in rows {
        let (path, title, snippet, tags_str, rank) = row?;
        let notebook = notebook_from_path(&path);
        let snippet_clean = snippet.replace("<mark>", "").replace("</mark>", "");
        let tags: Vec<String> = tags_str
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();

        results.push(SearchResult {
            note_path: path,
            title,
            notebook,
            snippet: snippet_clean,
            tags,
            relevance: -rank, // FTS5 rank is negative; negate so higher = better
            match_type: MatchType::Keyword,
        });
    }

    Ok(results)
}

// ─── Semantic Search ─────────────────────────────────────────────────────────

/// Semantic search: load ALL stored embeddings, compute cosine similarity against
/// the query embedding, return the top `limit` results sorted by similarity desc.
pub fn semantic_search(
    conn: &Connection,
    query_embedding: &[f32],
    limit: usize,
) -> Result<Vec<SearchResult>> {
    let mut stmt = conn.prepare("SELECT note_path, embedding FROM embeddings")?;
    let rows: Vec<(String, Vec<u8>)> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let dim = query_embedding.len();

    // Pack all embeddings into a contiguous matrix for batch processing
    let mut matrix = vec![0.0f32; rows.len() * dim];
    for (i, (_path, blob)) in rows.iter().enumerate() {
        let vec = bytes_to_embedding(blob);
        let copy_len = dim.min(vec.len());
        matrix[i * dim..i * dim + copy_len].copy_from_slice(&vec[..copy_len]);
    }

    let scores = batch_cosine_similarity(query_embedding, &matrix, dim);

    // Pair paths with scores, sort descending
    let mut scored: Vec<(usize, f32)> = scores.iter().copied().enumerate().collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);

    let mut results = Vec::with_capacity(scored.len());
    for (idx, score) in scored {
        let path = &rows[idx].0;

        // Look up title and tags from FTS table
        let fts_info: Option<(String, String)> = conn
            .prepare("SELECT title, tags FROM notes_fts WHERE path = ?1")?
            .query_row([path.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .ok();

        let (title, tags) = match fts_info {
            Some((t, tg)) => (
                t,
                tg.split_whitespace()
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect(),
            ),
            None => (title_from_path(path), Vec::new()),
        };

        results.push(SearchResult {
            note_path: path.clone(),
            title,
            notebook: notebook_from_path(path),
            snippet: String::new(),
            tags,
            relevance: score as f64,
            match_type: MatchType::Semantic,
        });
    }

    Ok(results)
}

// ─── Hybrid Search ───────────────────────────────────────────────────────────

/// Hybrid search: run both keyword and semantic search, normalize scores to [0,1],
/// merge with keyword * 0.4 + semantic * 0.6 weighting.
pub fn hybrid_search(
    conn: &Connection,
    query: &str,
    query_embedding: Option<&[f32]>,
    limit: usize,
) -> Result<Vec<SearchResult>> {
    let keyword_results = keyword_search(conn, query, limit * 2)?;

    let query_embedding = match query_embedding {
        Some(emb) => emb,
        None => {
            // No embedding available — return keyword-only results
            let mut results = keyword_results;
            results.truncate(limit);
            return Ok(results);
        }
    };

    let semantic_results = semantic_search(conn, query_embedding, limit * 2)?;

    // Find max scores for normalization (floor at 1.0 to avoid division by zero)
    let max_keyword = keyword_results
        .iter()
        .map(|r| r.relevance)
        .fold(1.0f64, f64::max);
    let max_semantic = semantic_results
        .iter()
        .map(|r| r.relevance)
        .fold(1.0f64, f64::max);

    // Merge into a map keyed by note_path
    let mut merged: HashMap<String, SearchResult> = HashMap::new();

    for r in keyword_results {
        let normalized = r.relevance / max_keyword;
        merged.insert(
            r.note_path.clone(),
            SearchResult {
                relevance: normalized * 0.4,
                match_type: MatchType::Hybrid,
                ..r
            },
        );
    }

    for r in semantic_results {
        let normalized = r.relevance / max_semantic;
        if let Some(existing) = merged.get_mut(&r.note_path) {
            existing.relevance += normalized * 0.6;
        } else {
            merged.insert(
                r.note_path.clone(),
                SearchResult {
                    relevance: normalized * 0.6,
                    match_type: MatchType::Hybrid,
                    ..r
                },
            );
        }
    }

    let mut results: Vec<SearchResult> = merged.into_values().collect();
    results.sort_by(|a, b| {
        b.relevance
            .partial_cmp(&a.relevance)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(limit);
    Ok(results)
}

// ─── Similar Notes ───────────────────────────────────────────────────────────

/// Find notes most similar to a given note using stored embeddings.
/// Only returns results above the `threshold` cosine similarity.
pub fn find_similar_notes(
    conn: &Connection,
    path: &str,
    limit: usize,
    threshold: f32,
) -> Result<Vec<SearchResult>> {
    let source_emb = match get_embedding(conn, path)? {
        Some(e) => e,
        None => return Ok(Vec::new()),
    };

    let mut stmt = conn.prepare(
        "SELECT note_path, embedding FROM embeddings WHERE note_path != ?1",
    )?;
    let rows: Vec<(String, Vec<u8>)> = stmt
        .query_map([path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let dim = source_emb.len();

    // Pack into matrix
    let mut matrix = vec![0.0f32; rows.len() * dim];
    for (i, (_path, blob)) in rows.iter().enumerate() {
        let vec = bytes_to_embedding(blob);
        let copy_len = dim.min(vec.len());
        matrix[i * dim..i * dim + copy_len].copy_from_slice(&vec[..copy_len]);
    }

    let scores = batch_cosine_similarity(&source_emb, &matrix, dim);

    // Filter by threshold, sort descending, truncate
    let mut scored: Vec<(usize, f32)> = scores
        .iter()
        .copied()
        .enumerate()
        .filter(|(_, s)| *s >= threshold)
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);

    let mut results = Vec::with_capacity(scored.len());
    for (idx, score) in scored {
        let note_path = &rows[idx].0;

        let fts_info: Option<(String, String)> = conn
            .prepare("SELECT title, tags FROM notes_fts WHERE path = ?1")?
            .query_row([note_path.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .ok();

        let (title, tags) = match fts_info {
            Some((t, tg)) => (
                t,
                tg.split_whitespace()
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect(),
            ),
            None => (title_from_path(note_path), Vec::new()),
        };

        results.push(SearchResult {
            note_path: note_path.clone(),
            title,
            notebook: notebook_from_path(note_path),
            snippet: String::new(),
            tags,
            relevance: score as f64,
            match_type: MatchType::Semantic,
        });
    }

    Ok(results)
}

// ─── Rebuild Index ───────────────────────────────────────────────────────────

/// Rebuild the full-text index by scanning all `.md` files under `notebooks_dir`.
/// Returns (indexed_count, error_count).
///
/// The caller is responsible for parsing frontmatter and calling `index_note`
/// for each file; this function provides the batch scaffolding.
pub fn rebuild_index(conn: &Connection, notebooks_dir: &std::path::Path) -> Result<(usize, usize)> {
    use std::fs;

    // Clear existing FTS data
    conn.execute_batch("DELETE FROM notes_fts")?;

    if !notebooks_dir.exists() {
        return Ok((0, 0));
    }

    let mut indexed = 0usize;
    let mut errors = 0usize;

    fn scan_dir(
        conn: &Connection,
        dir: &std::path::Path,
        vault_path: &std::path::Path,
        indexed: &mut usize,
        errors: &mut usize,
    ) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan_dir(conn, &path, vault_path, indexed, errors);
            } else if let Some(ext) = path.extension() {
                if ext == "md" {
                    if let Some(name) = path.file_name() {
                        if name == "_meta.md" {
                            continue;
                        }
                    }
                    match fs::read_to_string(&path) {
                        Ok(raw) => {
                            // Simple frontmatter extraction: skip YAML block between --- delimiters
                            let content = strip_frontmatter(&raw);
                            let title = path
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("")
                                .to_string();

                            // Extract tags from frontmatter (simple parsing)
                            let tags = extract_tags_from_frontmatter(&raw);

                            let rel_path = path
                                .strip_prefix(vault_path)
                                .map(|p| p.to_string_lossy().to_string())
                                .unwrap_or_else(|_| path.to_string_lossy().to_string());

                            if index_note(conn, &rel_path, &title, &content, &tags).is_ok() {
                                *indexed += 1;
                            } else {
                                *errors += 1;
                            }
                        }
                        Err(_) => {
                            *errors += 1;
                        }
                    }
                }
            }
        }
    }

    // vault_path is the parent of Notebooks
    let vault_path = notebooks_dir
        .parent()
        .unwrap_or(notebooks_dir);

    scan_dir(conn, notebooks_dir, vault_path, &mut indexed, &mut errors);

    Ok((indexed, errors))
}

/// Strip YAML frontmatter (between --- delimiters) from markdown content.
fn strip_frontmatter(raw: &str) -> String {
    if raw.starts_with("---") {
        if let Some(end) = raw[3..].find("---") {
            return raw[3 + end + 3..].to_string();
        }
    }
    raw.to_string()
}

/// Extract space-separated tags from YAML frontmatter.
fn extract_tags_from_frontmatter(raw: &str) -> String {
    if !raw.starts_with("---") {
        return String::new();
    }
    let end_idx = match raw[3..].find("---") {
        Some(idx) => idx + 3,
        None => return String::new(),
    };
    let frontmatter = &raw[3..end_idx];

    let mut tags = Vec::new();
    let mut in_tags = false;
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("tags:") {
            let inline = trimmed.strip_prefix("tags:").unwrap().trim();
            if inline.starts_with('[') {
                // Inline array: tags: [foo, bar]
                let inner = inline.trim_start_matches('[').trim_end_matches(']');
                for tag in inner.split(',') {
                    let t = tag.trim().trim_matches('"').trim_matches('\'');
                    if !t.is_empty() {
                        tags.push(t.to_string());
                    }
                }
                return tags.join(" ");
            }
            in_tags = true;
            continue;
        }
        if in_tags {
            if trimmed.starts_with("- ") {
                let tag = trimmed
                    .strip_prefix("- ")
                    .unwrap()
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'');
                if !tag.is_empty() {
                    tags.push(tag.to_string());
                }
            } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
                // End of tags list
                break;
            }
        }
    }
    tags.join(" ")
}

// ─── Tag Queries ─────────────────────────────────────────────────────────────

/// Get tag counts across all indexed notes.
pub fn get_all_tags(conn: &Connection) -> Result<HashMap<String, usize>> {
    let mut stmt = conn.prepare("SELECT tags FROM notes_fts WHERE tags != ''")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

    let mut counts: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let tags_str = row?;
        for tag in tags_str.split_whitespace() {
            if !tag.is_empty() {
                *counts.entry(tag.to_string()).or_insert(0) += 1;
            }
        }
    }
    Ok(counts)
}

/// Get note paths for a specific tag from the FTS index.
pub fn get_tagged_note_paths(conn: &Connection, tag: &str) -> Result<Vec<String>> {
    let escaped: String = tag
        .chars()
        .filter(|c| !"'\"){}[]*+^~!@#$%&".contains(*c))
        .collect();
    let escaped = escaped.trim().to_string();
    if escaped.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt =
        conn.prepare("SELECT path FROM notes_fts WHERE tags MATCH ?1 LIMIT 100")?;
    let rows = stmt.query_map([&escaped], |row| row.get::<_, String>(0))?;

    let mut paths = Vec::new();
    for row in rows {
        paths.push(row?);
    }
    Ok(paths)
}

// ─── Graph Links ─────────────────────────────────────────────────────────────

/// Record a graph link between two notes (UPSERT).
pub fn add_graph_link(
    conn: &Connection,
    source: &str,
    target: &str,
    score: f64,
    link_type: &str,
) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR REPLACE INTO graph_links (source_path, target_path, score, link_type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![source, target, score, link_type, now],
    )?;
    Ok(())
}

/// Remove all graph links where the note is either source or target.
pub fn remove_graph_links(conn: &Connection, path: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM graph_links WHERE source_path = ?1 OR target_path = ?1",
        [path],
    )?;
    Ok(())
}

/// Get all graph links originating from a specific note.
pub fn get_graph_links(conn: &Connection, path: &str) -> Result<Vec<GraphLink>> {
    let mut stmt = conn.prepare(
        "SELECT target_path, score, link_type FROM graph_links WHERE source_path = ?1",
    )?;
    let rows = stmt.query_map([path], |row| {
        Ok(GraphLink {
            target: row.get::<_, String>(0)?,
            score: row.get::<_, f64>(1)?,
            link_type: row.get::<_, String>(2)?,
        })
    })?;

    let mut links = Vec::new();
    for row in rows {
        links.push(row?);
    }
    Ok(links)
}

// ─── Link State ──────────────────────────────────────────────────────────────

/// Record that a note has been linked (with its content hash for change detection).
pub fn set_link_state(conn: &Connection, path: &str, content_hash: &str) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR REPLACE INTO link_state (note_path, last_linked_at, content_hash)
         VALUES (?1, ?2, ?3)",
        rusqlite::params![path, now, content_hash],
    )?;
    Ok(())
}

/// Get the link state for a note (when it was last linked and its content hash).
pub fn get_link_state(conn: &Connection, path: &str) -> Result<Option<LinkState>> {
    let mut stmt = conn.prepare(
        "SELECT last_linked_at, content_hash FROM link_state WHERE note_path = ?1",
    )?;
    let result = stmt.query_row([path], |row| {
        Ok(LinkState {
            last_linked_at: row.get::<_, i64>(0)?,
            content_hash: row.get::<_, String>(1)?,
        })
    });

    match result {
        Ok(state) => Ok(Some(state)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// ─── Stats ───────────────────────────────────────────────────────────────────

/// Get search index statistics: FTS count + embedding count.
pub fn get_stats(conn: &Connection) -> Result<SearchStats> {
    let fts_count: usize =
        conn.query_row("SELECT COUNT(*) FROM notes_fts", [], |row| row.get(0))?;
    let embedding_count: usize =
        conn.query_row("SELECT COUNT(*) FROM embeddings", [], |row| row.get(0))?;
    Ok(SearchStats {
        fts_count,
        embedding_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../sql/001_initial.sql")).unwrap();
        conn.execute_batch(include_str!("../sql/002_graph_links.sql")).unwrap();
        conn
    }

    #[test]
    fn test_cosine_similarity_identical() {
        let a = vec![1.0, 2.0, 3.0];
        assert!((cosine_similarity(&a, &a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_orthogonal() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        assert!((cosine_similarity(&a, &b)).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_zero_vector() {
        let a = vec![1.0, 2.0];
        let b = vec![0.0, 0.0];
        assert_eq!(cosine_similarity(&a, &b), 0.0);
    }

    #[test]
    fn test_batch_cosine_similarity() {
        let query = vec![1.0, 0.0];
        let matrix = vec![1.0, 0.0, 0.0, 1.0, 0.5, 0.5];
        let scores = batch_cosine_similarity(&query, &matrix, 2);
        assert_eq!(scores.len(), 3);
        assert!((scores[0] - 1.0).abs() < 1e-6);
        assert!((scores[1]).abs() < 1e-6);
    }

    #[test]
    fn test_embedding_roundtrip() {
        let original = vec![1.0f32, -2.5, 3.14, 0.0];
        let bytes = embedding_to_bytes(&original);
        let recovered = bytes_to_embedding(&bytes);
        assert_eq!(original, recovered);
    }

    #[test]
    fn test_sanitize_fts_query() {
        assert_eq!(sanitize_fts_query("hello:world"), "hello world");
        assert_eq!(sanitize_fts_query("foo-bar"), "foo bar");
        assert_eq!(sanitize_fts_query("  spaces  "), "spaces");
    }

    #[test]
    fn test_index_and_keyword_search() {
        let conn = setup_test_db();
        index_note(&conn, "Notebooks/Projects/test.md", "Test Note", "hello world content", "rust search").unwrap();
        let results = keyword_search(&conn, "hello world", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].note_path, "Notebooks/Projects/test.md");
        assert_eq!(results[0].title, "Test Note");
        assert_eq!(results[0].notebook, "Projects");
    }

    #[test]
    fn test_remove_note() {
        let conn = setup_test_db();
        index_note(&conn, "test.md", "Test", "content", "").unwrap();
        store_embedding(&conn, "test.md", &[1.0, 2.0, 3.0], "test-model").unwrap();
        remove_note(&conn, "test.md").unwrap();
        assert_eq!(indexed_count(&conn).unwrap(), 0);
        assert!(get_embedding(&conn, "test.md").unwrap().is_none());
    }

    #[test]
    fn test_store_and_get_embedding() {
        let conn = setup_test_db();
        let emb = vec![0.1, 0.2, 0.3, 0.4];
        store_embedding(&conn, "note.md", &emb, "test-model").unwrap();
        let loaded = get_embedding(&conn, "note.md").unwrap().unwrap();
        assert_eq!(emb, loaded);
    }

    #[test]
    fn test_graph_links() {
        let conn = setup_test_db();
        add_graph_link(&conn, "a.md", "b.md", 0.95, "semantic").unwrap();
        add_graph_link(&conn, "a.md", "c.md", 0.80, "explicit").unwrap();

        let links = get_graph_links(&conn, "a.md").unwrap();
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].target, "b.md");

        remove_graph_links(&conn, "a.md").unwrap();
        let links = get_graph_links(&conn, "a.md").unwrap();
        assert!(links.is_empty());
    }

    #[test]
    fn test_link_state() {
        let conn = setup_test_db();
        assert!(get_link_state(&conn, "note.md").unwrap().is_none());

        set_link_state(&conn, "note.md", "abc123").unwrap();
        let state = get_link_state(&conn, "note.md").unwrap().unwrap();
        assert_eq!(state.content_hash, "abc123");
        assert!(state.last_linked_at > 0);
    }

    #[test]
    fn test_get_stats() {
        let conn = setup_test_db();
        index_note(&conn, "a.md", "A", "content a", "").unwrap();
        index_note(&conn, "b.md", "B", "content b", "").unwrap();
        store_embedding(&conn, "a.md", &[1.0], "m").unwrap();

        let stats = get_stats(&conn).unwrap();
        assert_eq!(stats.fts_count, 2);
        assert_eq!(stats.embedding_count, 1);
    }

    #[test]
    fn test_get_all_tags() {
        let conn = setup_test_db();
        index_note(&conn, "a.md", "A", "content", "rust search").unwrap();
        index_note(&conn, "b.md", "B", "content", "rust ai").unwrap();

        let tags = get_all_tags(&conn).unwrap();
        assert_eq!(tags.get("rust"), Some(&2));
        assert_eq!(tags.get("search"), Some(&1));
        assert_eq!(tags.get("ai"), Some(&1));
    }

    #[test]
    fn test_semantic_search() {
        let conn = setup_test_db();
        index_note(&conn, "a.md", "Note A", "content a", "").unwrap();
        index_note(&conn, "b.md", "Note B", "content b", "").unwrap();
        store_embedding(&conn, "a.md", &[1.0, 0.0, 0.0], "m").unwrap();
        store_embedding(&conn, "b.md", &[0.0, 1.0, 0.0], "m").unwrap();

        let results = semantic_search(&conn, &[1.0, 0.0, 0.0], 10).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].note_path, "a.md"); // most similar
        assert!((results[0].relevance - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_hybrid_search() {
        let conn = setup_test_db();
        index_note(&conn, "a.md", "Rust Programming", "rust language systems", "rust").unwrap();
        store_embedding(&conn, "a.md", &[1.0, 0.0], "m").unwrap();

        let results = hybrid_search(&conn, "rust", Some(&[1.0, 0.0]), 10).unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].match_type, MatchType::Hybrid);
    }

    #[test]
    fn test_find_similar_notes() {
        let conn = setup_test_db();
        index_note(&conn, "a.md", "A", "c", "").unwrap();
        index_note(&conn, "b.md", "B", "c", "").unwrap();
        index_note(&conn, "c.md", "C", "c", "").unwrap();
        store_embedding(&conn, "a.md", &[1.0, 0.0], "m").unwrap();
        store_embedding(&conn, "b.md", &[0.9, 0.1], "m").unwrap();
        store_embedding(&conn, "c.md", &[0.0, 1.0], "m").unwrap();

        let results = find_similar_notes(&conn, "a.md", 5, 0.5).unwrap();
        assert_eq!(results.len(), 1); // only b.md is above 0.5 threshold
        assert_eq!(results[0].note_path, "b.md");
    }

    #[test]
    fn test_strip_frontmatter() {
        let raw = "---\ntitle: Test\ntags:\n  - foo\n---\n# Hello\nWorld";
        let content = strip_frontmatter(raw);
        assert!(content.contains("# Hello"));
        assert!(!content.contains("title: Test"));
    }

    #[test]
    fn test_extract_tags_list() {
        let raw = "---\ntitle: Test\ntags:\n  - foo\n  - bar\n---\ncontent";
        let tags = extract_tags_from_frontmatter(raw);
        assert_eq!(tags, "foo bar");
    }

    #[test]
    fn test_extract_tags_inline() {
        let raw = "---\ntags: [alpha, beta]\n---\ncontent";
        let tags = extract_tags_from_frontmatter(raw);
        assert_eq!(tags, "alpha beta");
    }
}
