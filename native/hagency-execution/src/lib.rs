//! Host-only, single-operation integration. Production availability is false:
//! directory provisioning, effective sandbox and owner approval IO remain gates.
mod host;
mod operation;
pub use host::{Host, Limits};
pub use operation::{Failure, Operation, Protocol, Report, Settlement};
#[cfg(test)]
#[path = "../tests/support/reply_loss.rs"]
mod reply_loss;
