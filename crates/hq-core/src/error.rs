use thiserror::Error;

#[derive(Error, Debug)]
pub enum HqError {
    #[error("vault error: {0}")]
    Vault(String),

    #[error("database error: {0}")]
    Database(#[from] DatabaseError),

    #[error("LLM error: {0}")]
    Llm(String),

    #[error("config error: {0}")]
    Config(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serialization(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("{0}")]
    Other(String),
}

#[derive(Error, Debug)]
pub enum DatabaseError {
    #[error("SQLite error: {0}")]
    Sqlite(String),

    #[error("migration error: {0}")]
    Migration(String),

    #[error("query error: {0}")]
    Query(String),
}

pub type HqResult<T> = Result<T, HqError>;
