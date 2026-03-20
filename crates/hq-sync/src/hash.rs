//! Content hashing utilities using SHA-256.

use anyhow::Result;
use sha2::{Digest, Sha256};
use std::path::Path;

/// Compute SHA-256 hash of a file's contents. Returns hex-encoded string.
pub fn hash_file(path: &Path) -> Result<String> {
    let content = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&content);
    Ok(hex::encode(hasher.finalize()))
}

/// Compute SHA-256 hash of a string. Returns hex-encoded string.
pub fn hash_string(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

/// Generate a deterministic device ID from hostname and vault path.
/// Returns the first 16 hex characters of SHA-256("{hostname}:{vault_path}").
pub fn generate_device_id(vault_path: &Path) -> String {
    let host = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let input = format!("{}:{}", host, vault_path.display());
    let hash = hash_string(&input);
    hash[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_string_deterministic() {
        let h1 = hash_string("hello world");
        let h2 = hash_string("hello world");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex is 64 chars
    }

    #[test]
    fn test_hash_string_different_inputs() {
        let h1 = hash_string("hello");
        let h2 = hash_string("world");
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_generate_device_id_length() {
        let id = generate_device_id(Path::new("/tmp/vault"));
        assert_eq!(id.len(), 16);
    }
}
