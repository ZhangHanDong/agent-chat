//! One bootstrap-owned binding, deliberately not a public source reader yet.
use super::Failure;
use hagency_core::tasks::RunnerCapability;
use hagency_execution::StartedWorkspace;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

struct Entry {
    capability: RunnerCapability,
    binding: StartedWorkspace,
}
#[derive(Clone)]
pub(super) struct WorkspaceAccess {
    entry: Arc<Mutex<Option<Arc<Entry>>>>,
    retired: Arc<AtomicBool>,
}
pub(super) struct Rejected {
    pub capability: RunnerCapability,
    pub binding: StartedWorkspace,
}
impl WorkspaceAccess {
    pub fn new() -> Self {
        Self {
            entry: Arc::new(Mutex::new(None)),
            retired: Arc::new(AtomicBool::new(false)),
        }
    }
    pub async fn register(
        &self,
        capability: RunnerCapability,
        binding: StartedWorkspace,
    ) -> Result<(), Rejected> {
        if self.retired.load(Ordering::Acquire)
            || binding.validate_current(&capability).await.is_err()
        {
            return Err(Rejected {
                capability,
                binding,
            });
        }
        let Ok(mut entry) = self.entry.lock() else {
            return Err(Rejected {
                capability,
                binding,
            });
        };
        if self.retired.load(Ordering::Acquire) || entry.is_some() {
            return Err(Rejected {
                capability,
                binding,
            });
        }
        *entry = Some(Arc::new(Entry {
            capability,
            binding,
        }));
        Ok(())
    }
    pub fn retire(&self) {
        self.retired.store(true, Ordering::Release);
    }
    pub async fn check(&self, capability: &RunnerCapability) -> Result<(), Failure> {
        if self.retired.load(Ordering::Acquire) {
            return Err(Failure::Registration);
        }
        let entry = self
            .entry
            .lock()
            .map_err(|_| Failure::Registration)?
            .clone()
            .ok_or(Failure::Registration)?;
        if entry.capability.dispatch_id != capability.dispatch_id
            || entry.capability.runner_id != capability.runner_id
            || entry.capability.fence != capability.fence
            || entry.capability.secret != capability.secret
        {
            return Err(Failure::Registration);
        }
        entry
            .binding
            .validate_current(capability)
            .await
            .map_err(|_| Failure::Registration)?;
        if self.retired.load(Ordering::Acquire) {
            return Err(Failure::Registration);
        }
        Ok(())
    }
}
