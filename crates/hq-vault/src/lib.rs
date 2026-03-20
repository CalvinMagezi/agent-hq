//! Vault filesystem operations — read/write markdown notes with frontmatter.

pub mod atomic_queue;
pub mod client;
pub mod frontmatter;
pub mod jobs;
pub mod notes;
pub mod query;
pub mod system;
pub mod tasks;
pub mod usage;

pub use atomic_queue::AtomicQueue;
pub use client::VaultClient;
pub use query::NoteQuery;
