//! Host-only, single-operation integration. Production availability is false:
//! directory provisioning, effective sandbox and owner approval IO remain gates.
mod host;
mod operation;
mod registration;
mod usage;
mod workspace;
pub use host::{Host, Limits};
pub use operation::{Failure, Operation, Protocol, Report, Settlement};
pub use registration::{LaunchAck, RegistrationError, WorkspaceRegistration};
pub use usage::{UsageFailure, UsageStatus};
pub use workspace::{StartedWorkspace, WorkspaceError, WorkspaceReceive, WorkspaceReceiveError};
#[cfg(test)]
#[path = "../tests/support/reply_loss.rs"]
mod reply_loss;
#[cfg(test)]
#[path = "../../hagency-store/tests/common/mod.rs"]
mod test_common;
