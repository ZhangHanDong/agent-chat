//! Shared native domain contracts. No HTTP, database, process or Matrix SDK IO.
pub mod allocation;
pub mod canonical;
pub mod custody;

pub const JSON_SAFE_MAX: u64 = 9_007_199_254_740_991;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct InvalidInput(pub &'static str);
