//! Host-only, single-operation integration. Production availability is false:
//! directory provisioning, effective sandbox and owner approval IO remain gates.
mod host;
mod operation;
mod usage;
pub use host::{Host, Limits};
pub use operation::{Failure, Operation, Protocol, Report, Settlement};
pub use usage::{UsageFailure, UsageStatus};
#[cfg(test)]
#[path = "../tests/support/reply_loss.rs"]
mod reply_loss;
#[cfg(test)]
#[path = "../../hagency-store/tests/common/mod.rs"]
mod test_common;
