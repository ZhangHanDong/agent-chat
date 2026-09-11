//! Fixed-size, host-local observations of one shutdown attempt. Never authority.
use std::{
    sync::atomic::{AtomicU16, AtomicU64, Ordering},
    time::Instant,
};

/// The original caller verdict, with the wait stage distinguished for diagnosis.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownOutcome {
    Complete,
    EnqueueTimedOut,
    ReplyTimedOut,
    EnqueueClosed,
    ReplyClosed,
}

/// A momentary snapshot, in microseconds relative to this attempt's creation.
///
/// Missing phases mean unobserved, not rollback or repository closure. Worker
/// pickup can precede the caller observing enqueue completion. Likewise a caller
/// can receive the acknowledgement before its sender publishes `sent_us`.
/// `Complete` preserves the original acknowledgement verdict; this snapshot
/// neither proves OS-thread exit nor adds any permission to retry a write.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ShutdownSnapshot {
    pub outcome: ShutdownOutcome,
    pub enqueue_started_us: Option<u64>,
    pub enqueue_observed_us: Option<u64>,
    pub worker_picked_up_us: Option<u64>,
    pub drop_started_us: Option<u64>,
    pub drop_finished_us: Option<u64>,
    /// Domain repository fields only; absent for custody-store shutdown.
    pub connection_drop_started_us: Option<u64>,
    pub connection_drop_finished_us: Option<u64>,
    pub ownership_drop_started_us: Option<u64>,
    pub ownership_drop_finished_us: Option<u64>,
    pub acknowledgement_started_us: Option<u64>,
    pub acknowledgement_sent_us: Option<u64>,
    pub caller_finished_us: Option<u64>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum Phase {
    EnqueueStarted,
    EnqueueObserved,
    WorkerPickedUp,
    DropStarted,
    DropFinished,
    AcknowledgementStarted,
    AcknowledgementSent,
    CallerFinished,
    ConnectionDropStarted,
    ConnectionDropFinished,
    OwnershipDropStarted,
    OwnershipDropFinished,
}

pub(crate) struct Probe {
    started: Instant,
    timestamps: [AtomicU64; 12],
    completed: AtomicU16,
    #[cfg(test)]
    pause: std::sync::Mutex<Option<TestPause>>,
}

impl Probe {
    pub(crate) fn new() -> Self {
        Self {
            started: Instant::now(),
            timestamps: std::array::from_fn(|_| AtomicU64::new(0)),
            completed: AtomicU16::new(0),
            #[cfg(test)]
            pause: std::sync::Mutex::new(None),
        }
    }

    // Each phase has exactly one publisher per attempt. Publish its timestamp
    // before the Release bit; snapshot's Acquire makes that timestamp visible.
    pub(crate) fn mark(&self, phase: Phase) {
        let index = phase as usize;
        let elapsed = u64::try_from(self.started.elapsed().as_micros()).unwrap_or(u64::MAX);
        self.timestamps[index].store(elapsed, Ordering::Relaxed);
        self.completed.fetch_or(1 << index, Ordering::Release);
        #[cfg(test)]
        self.pause_at(phase);
    }

    pub(crate) fn snapshot(&self, outcome: ShutdownOutcome) -> ShutdownSnapshot {
        let completed = self.completed.load(Ordering::Acquire);
        let at = |phase: Phase| {
            let index = phase as usize;
            (completed & (1 << index) != 0).then(|| self.timestamps[index].load(Ordering::Relaxed))
        };
        ShutdownSnapshot {
            outcome,
            enqueue_started_us: at(Phase::EnqueueStarted),
            enqueue_observed_us: at(Phase::EnqueueObserved),
            worker_picked_up_us: at(Phase::WorkerPickedUp),
            drop_started_us: at(Phase::DropStarted),
            drop_finished_us: at(Phase::DropFinished),
            connection_drop_started_us: at(Phase::ConnectionDropStarted),
            connection_drop_finished_us: at(Phase::ConnectionDropFinished),
            ownership_drop_started_us: at(Phase::OwnershipDropStarted),
            ownership_drop_finished_us: at(Phase::OwnershipDropFinished),
            acknowledgement_started_us: at(Phase::AcknowledgementStarted),
            acknowledgement_sent_us: at(Phase::AcknowledgementSent),
            caller_finished_us: at(Phase::CallerFinished),
        }
    }
}

pub(crate) fn mark(probe: &Option<std::sync::Arc<Probe>>, phase: Phase) {
    if let Some(probe) = probe {
        probe.mark(phase);
    }
}

#[cfg(test)]
struct TestPause {
    phase: Phase,
    reached: tokio::sync::oneshot::Sender<()>,
    resume: std::sync::mpsc::Receiver<()>,
}

#[cfg(test)]
impl Probe {
    pub(crate) fn paused(
        phase: Phase,
    ) -> (
        std::sync::Arc<Self>,
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let probe = std::sync::Arc::new(Self::new());
        let (reached, received) = tokio::sync::oneshot::channel();
        let (resume, paused) = std::sync::mpsc::channel();
        *probe.pause.lock().unwrap() = Some(TestPause {
            phase,
            reached,
            resume: paused,
        });
        (probe, received, resume)
    }

    fn pause_at(&self, phase: Phase) {
        let pause = {
            let mut pause = self.pause.lock().unwrap();
            if pause.as_ref().is_some_and(|pause| pause.phase == phase) {
                pause.take()
            } else {
                None
            }
        };
        if let Some(pause) = pause {
            let _ = pause.reached.send(());
            // A test panic drops resume; the worker must never be stranded.
            let _ = pause.resume.recv_timeout(std::time::Duration::from_secs(6));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn native_domain_shutdown_snapshot() {
        let probe = Arc::new(Probe::new());
        let other = Probe::new();
        let (tx, rx) = std::sync::mpsc::sync_channel(0);
        let worker = {
            let probe = probe.clone();
            std::thread::spawn(move || {
                for phase in [
                    Phase::WorkerPickedUp,
                    Phase::DropStarted,
                    Phase::DropFinished,
                ] {
                    probe.mark(phase);
                    tx.send(()).unwrap();
                }
            })
        };
        for _ in 0..3 {
            rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
            let snapshot = probe.snapshot(ShutdownOutcome::ReplyTimedOut);
            assert!(snapshot.worker_picked_up_us.is_some());
            if let Some(finished) = snapshot.drop_finished_us {
                assert!(finished >= snapshot.drop_started_us.unwrap());
            }
            assert_eq!(snapshot.enqueue_started_us, None);
        }
        worker.join().unwrap();
        let snapshot = probe.snapshot(ShutdownOutcome::ReplyTimedOut);
        assert!(snapshot.drop_finished_us.is_some());
        assert_eq!(snapshot.connection_drop_started_us, None);
        assert_eq!(snapshot.connection_drop_finished_us, None);
        assert_eq!(snapshot.ownership_drop_started_us, None);
        assert_eq!(snapshot.ownership_drop_finished_us, None);
        // Caller enqueue observation can arrive after ALL these worker phases;
        // publishing it must not regress the independently observed worker.
        probe.mark(Phase::EnqueueObserved);
        let later = probe.snapshot(ShutdownOutcome::ReplyTimedOut);
        assert_eq!(later.drop_finished_us, snapshot.drop_finished_us);
        assert!(later.enqueue_observed_us.unwrap() >= later.drop_finished_us.unwrap());
        assert_eq!(
            other
                .snapshot(ShutdownOutcome::ReplyTimedOut)
                .drop_finished_us,
            None
        );
        // Zero elapsed microseconds is a real observation, not our absent
        // sentinel. A timestamp without its completion publication stays absent.
        other.timestamps[Phase::EnqueueStarted as usize].store(0, Ordering::Relaxed);
        assert_eq!(
            other
                .snapshot(ShutdownOutcome::EnqueueTimedOut)
                .enqueue_started_us,
            None
        );
        other.completed.store(1, Ordering::Release);
        assert_eq!(
            other
                .snapshot(ShutdownOutcome::EnqueueTimedOut)
                .enqueue_started_us,
            Some(0)
        );
        // The four additional optional field timestamps add exactly64 bytes
        // to the previous finite144-byte cap; no variable-size data is stored.
        assert!(std::mem::size_of::<ShutdownSnapshot>() <= 208);
    }
}
