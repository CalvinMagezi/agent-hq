//! E2E encryption for vault sync protocol.
//!
//! Algorithm: AES-256-GCM
//! Key derivation: PBKDF2 (SHA-256, 100k iterations)
//! Nonce: 12 random bytes per message

use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, OsRng},
};
use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const PBKDF2_ITERATIONS: u32 = 100_000;
const NONCE_SIZE: usize = 12;
const KEY_LENGTH: usize = 32; // 256 bits

/// Encrypted envelope for sync protocol wire format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedEnvelope {
    /// Protocol version
    pub v: u8,
    /// Base64-encoded 12-byte nonce
    pub nonce: String,
    /// Base64-encoded ciphertext (includes auth tag)
    pub ciphertext: String,
}

/// A derived vault encryption key (AES-256-GCM).
pub struct VaultKey {
    key_bytes: [u8; KEY_LENGTH],
}

impl VaultKey {
    /// Derive an AES-256-GCM key from a passphrase and salt using PBKDF2.
    pub fn derive(passphrase: &str, salt: &str) -> Self {
        let mut key_bytes = [0u8; KEY_LENGTH];
        pbkdf2_hmac::<Sha256>(
            passphrase.as_bytes(),
            salt.as_bytes(),
            PBKDF2_ITERATIONS,
            &mut key_bytes,
        );
        Self { key_bytes }
    }

    /// Generate a vault ID from this key.
    /// `vaultId = hex(SHA-256(raw_key_bytes)).slice(0, 32)`
    pub fn vault_id(&self) -> String {
        let hash = Sha256::digest(&self.key_bytes);
        hex::encode(hash)[..32].to_string()
    }

    /// Encrypt a plaintext string into an EncryptedEnvelope.
    pub fn encrypt(&self, plaintext: &str) -> Result<EncryptedEnvelope> {
        let cipher = Aes256Gcm::new_from_slice(&self.key_bytes)
            .map_err(|e| anyhow::anyhow!("cipher init: {}", e))?;

        let mut nonce_bytes = [0u8; NONCE_SIZE];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| anyhow::anyhow!("encrypt: {}", e))?;

        Ok(EncryptedEnvelope {
            v: 1,
            nonce: BASE64.encode(nonce_bytes),
            ciphertext: BASE64.encode(ciphertext),
        })
    }

    /// Decrypt an EncryptedEnvelope back to plaintext.
    pub fn decrypt(&self, envelope: &EncryptedEnvelope) -> Result<String> {
        let cipher = Aes256Gcm::new_from_slice(&self.key_bytes)
            .map_err(|e| anyhow::anyhow!("cipher init: {}", e))?;

        let nonce_bytes = BASE64
            .decode(&envelope.nonce)
            .context("decode nonce")?;
        let ciphertext = BASE64
            .decode(&envelope.ciphertext)
            .context("decode ciphertext")?;

        let nonce = Nonce::from_slice(&nonce_bytes);
        let plaintext = cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|e| anyhow::anyhow!("decrypt: {}", e))?;

        String::from_utf8(plaintext).context("plaintext not valid UTF-8")
    }
}

/// Generate a stable device ID from hostname and vault path.
/// `deviceId = hex(SHA-256("{hostname}:{vaultPath}")).slice(0, 16)`
pub fn generate_device_id(hostname: &str, vault_path: &str) -> String {
    let input = format!("{}:{}", hostname, vault_path);
    let hash = Sha256::digest(input.as_bytes());
    hex::encode(hash)[..16].to_string()
}

/// Generate a random 6-digit numeric pairing code.
pub fn generate_pairing_code() -> String {
    let mut bytes = [0u8; 4];
    OsRng.fill_bytes(&mut bytes);
    let num = u32::from_be_bytes(bytes);
    format!("{:06}", num % 1_000_000)
}

/// Hash a pairing code for safe transmission.
pub fn hash_pairing_code(code: &str) -> String {
    let hash = Sha256::digest(code.as_bytes());
    hex::encode(hash)
}

/// Compute SHA-256 hash of content.
pub fn hash_content(content: &str) -> String {
    let hash = Sha256::digest(content.as_bytes());
    hex::encode(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_key_is_deterministic() {
        let k1 = VaultKey::derive("password123", "my-vault");
        let k2 = VaultKey::derive("password123", "my-vault");
        assert_eq!(k1.key_bytes, k2.key_bytes);
    }

    #[test]
    fn different_passwords_give_different_keys() {
        let k1 = VaultKey::derive("password1", "salt");
        let k2 = VaultKey::derive("password2", "salt");
        assert_ne!(k1.key_bytes, k2.key_bytes);
    }

    #[test]
    fn vault_id_is_32_hex_chars() {
        let key = VaultKey::derive("test", "salt");
        let id = key.vault_id();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = VaultKey::derive("my-secret", "vault-id");
        let plaintext = "Hello, World! This is a secret message.";

        let envelope = key.encrypt(plaintext).unwrap();
        assert_eq!(envelope.v, 1);
        assert!(!envelope.nonce.is_empty());
        assert!(!envelope.ciphertext.is_empty());

        let decrypted = key.decrypt(&envelope).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn wrong_key_fails_decrypt() {
        let key1 = VaultKey::derive("correct-password", "salt");
        let key2 = VaultKey::derive("wrong-password", "salt");

        let envelope = key1.encrypt("secret data").unwrap();
        assert!(key2.decrypt(&envelope).is_err());
    }

    #[test]
    fn device_id_is_16_hex_chars() {
        let id = generate_device_id("my-host", "/path/to/vault");
        assert_eq!(id.len(), 16);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn pairing_code_is_6_digits() {
        let code = generate_pairing_code();
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn hash_pairing_code_is_64_hex_chars() {
        let hash = hash_pairing_code("123456");
        assert_eq!(hash.len(), 64);
    }
}
