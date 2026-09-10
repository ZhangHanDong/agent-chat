//! Host-only bridge from retained process custody to one bounded Codex session.
//! No server route constructs this type; sandbox/dispatch qualification is open.
use hagency_platform::SupervisedReport;
use std::io;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::OwnedSession;

/// Exact platform observations, deliberately distinct from upstream completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cleanup {
    Pending,
    Observed(SupervisedReport),
    Unknown { kind: io::ErrorKind },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum StartError {
    #[error("invalid host runner settings")]
    Settings,
    #[error("native runner piped platform is unavailable")]
    Unsupported,
    /// The existing supervisor may have lost startup acknowledgement after spawn.
    /// Absence of a returned owner is never proof that no child briefly executed.
    #[error("native runner startup or IO handoff failed; cleanup must be inspected")]
    Uncertain {
        kind: io::ErrorKind,
        cleanup: Cleanup,
    },
}

#[cfg(windows)]
pub struct OwnedSession {
    _unavailable: (),
}
#[cfg(windows)]
impl OwnedSession {
    pub fn spawn(
        _guardian: &std::path::Path,
        _launch: &hagency_platform::Launch,
        _settings: crate::codex::session::Settings,
        _limits: crate::codex::transport::Limits,
        _response_timeout_ms: u64,
    ) -> Result<Self, StartError> {
        Err(StartError::Unsupported)
    }
}
