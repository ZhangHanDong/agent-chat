//! Current dispatch authority around retained manifests and bounded decryption.
//! Host-local memory only: no cache path, MCP endpoint or enduring export grant.
use crate::{
    CancellationToken, Collector, Error, MediaDownloadError, MediaDownloadLimits, MediaDownloader,
};
use hagency_core::{attachments::AttachmentMetadata, tasks::RunnerCapability};
use hagency_media::CheckedBytes;
use std::sync::{Arc, OnceLock};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::Instant,
};

const MAX_RESULTS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ReceiveError {
    #[error(transparent)]
    Authority(#[from] Error),
    #[error(transparent)]
    Download(#[from] MediaDownloadError),
}

pub(crate) struct Receiver {
    downloader: OnceLock<Result<MediaDownloader, MediaDownloadError>>,
    results: Arc<Semaphore>,
}
impl Receiver {
    pub(crate) fn new() -> Self {
        Self {
            downloader: OnceLock::new(),
            results: Arc::new(Semaphore::new(MAX_RESULTS)),
        }
    }
}

/// Complete checked bytes from an authenticated retained manifest, scoped at
/// return time. Later revocation cannot erase a trusted holder's memory; delayed
/// export requires current authority again. No serialization or public constructor.
pub struct ReceivedAttachment {
    checked: CheckedBytes,
    metadata: AttachmentMetadata,
    _permit: OwnedSemaphorePermit,
}
impl ReceivedAttachment {
    pub fn bytes(&self) -> &[u8] {
        self.checked.bytes()
    }
    pub fn digest(&self) -> &[u8; 32] {
        self.checked.digest()
    }
    /// Validated syntax only; MIME and declared size are sender observations.
    pub fn metadata(&self) -> &AttachmentMetadata {
        &self.metadata
    }
}

impl Collector {
    /// Uses prior authenticated collector observations and current domain truth,
    /// not a claim that remote room membership cannot change between observations.
    pub async fn receive_attachment(
        &self,
        cap: RunnerCapability,
        event_id: String,
        cancel: &CancellationToken,
    ) -> Result<ReceivedAttachment, ReceiveError> {
        let deadline = Instant::now() + self.inner.config.limits.sdk;
        checkpoint(cancel, deadline)?;
        let permit = self
            .inner
            .receiver
            .results
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Capacity)?;
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Error::Cancelled.into()),
            _ = tokio::time::sleep_until(deadline) => Err(Error::Timeout.into()),
            result = self.receive(cap, event_id, cancel, deadline, permit) => {
                checkpoint(cancel, deadline)?;
                result
            }
        }
    }
    async fn receive(
        &self,
        cap: RunnerCapability,
        event_id: String,
        cancel: &CancellationToken,
        deadline: Instant,
        permit: OwnedSemaphorePermit,
    ) -> Result<ReceivedAttachment, ReceiveError> {
        let ticket = self
            .inner
            .domain
            .authorize_attachment(cap.clone(), event_id)
            .await
            .map_err(Error::from)?;
        let handle = self
            .attachment_manifest(cap.clone(), ticket.clone(), cancel)
            .await?;
        // Lookup's Owner mutex and busy permit are gone before network waits:
        // intake and authenticated negative observations must remain runnable.
        let downloader = self
            .inner
            .receiver
            .downloader
            .get_or_init(|| {
                MediaDownloader::new(&self.inner.config, MediaDownloadLimits::default())
            })
            .as_ref()
            .map_err(|e| *e)?;
        let checked = downloader
            .download_until(handle.media_id(), handle.descriptor(), cancel, deadline)
            .await?;
        self.inner
            .domain
            .revalidate_attachment(cap, ticket.clone())
            .await
            .map_err(Error::from)?;
        checkpoint(cancel, deadline)?;
        Ok(ReceivedAttachment {
            checked,
            metadata: ticket.metadata().clone(),
            _permit: permit,
        })
    }
}
fn checkpoint(cancel: &CancellationToken, deadline: Instant) -> Result<(), Error> {
    if cancel.is_cancelled() {
        Err(Error::Cancelled)
    } else if Instant::now() >= deadline {
        Err(Error::Timeout)
    } else {
        Ok(())
    }
}
