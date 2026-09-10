//! A single SQLite owner on a dedicated bounded worker; no IO in async handlers.
pub mod private;
mod repository;
mod worker;
pub use repository::Repository;
pub use worker::Store;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid input: {0}")]
    Invalid(#[from] hagency_core::InvalidInput),
    #[error("request identifier was reused with different content")]
    Conflict,
    #[error("registration generation differs from its durable binding")]
    Generation,
    #[error("state is owned by another process")]
    Locked,
    #[error("state format is corrupt or newer than this binary")]
    Schema,
    #[error("state must be an owner-private directory containing regular files")]
    Private,
    #[error("private state on this platform has not passed the native permission gate")]
    PlatformUnavailable,
    #[error("custody capacity is exhausted; no unprocessed delivery was discarded")]
    Capacity,
    #[error("worker queue is full; retry the same request identifier")]
    Busy,
    #[error("worker stopped; inspect or retry the same request identifier")]
    Unavailable,
    #[error("processing outcome is unknown; retry only the identical custody command")]
    OutcomeUnknown,
    #[error("storage error")]
    Sqlite(#[from] rusqlite::Error),
    #[error("filesystem error")]
    Io(#[from] std::io::Error),
    #[error("serialization error")]
    Json(#[from] serde_json::Error),
}
