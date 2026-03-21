//! Vault file sync and watching — file change detection, scanning, and content hashing.

pub mod crypto;
pub mod hash;
pub mod protocol;
pub mod scanner;
pub mod watcher;

pub use crypto::{EncryptedEnvelope, VaultKey};
pub use hash::{generate_device_id, hash_file, hash_string};
pub use protocol::{SyncMessage, SyncChangeEntry, WireMessage};
pub use scanner::{scan_vault, FileEntry};
pub use watcher::{ChangeType, FileChange, FileWatcher};
