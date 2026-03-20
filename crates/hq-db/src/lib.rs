//! SQLite database layer — single consolidated database for all HQ data.

pub mod migrations;
pub mod pool;
pub mod search;

pub use pool::Database;
