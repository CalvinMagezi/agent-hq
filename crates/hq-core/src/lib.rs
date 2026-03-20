//! Core types, configuration, and error definitions for Agent-HQ.

pub mod config;
pub mod error;
pub mod types;

pub use config::HqConfig;
pub use error::HqError;
