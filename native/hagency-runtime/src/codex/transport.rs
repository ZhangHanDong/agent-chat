//! Host-owned stream driver. Closing streams is not evidence of child cleanup.
mod buffers;
mod control;
pub(super) use control::{Controlled, PreparedFrame};

use super::{
    Connection, Error as ProtocolError, Event, MAX_REQUEST_MS, Phase, RequestId, TurnScope,
};
use buffers::{EventQueue, PrivateStderr};
use serde_json::Value;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::Instant;

pub const READ_BYTES: usize = 16 * 1024;
pub const STDERR_BYTES: usize = 16 * 1024;
pub const MAX_EVENTS: usize = 16;
pub const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;

pub(super) fn event_bytes(event: &Event) -> Result<usize, Error> {
    buffers::charge(event)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("invalid native runner transport limits")]
    Configuration,
    #[error("native runner transport is closed")]
    Closed,
    #[error("native runner transport operation was cancelled")]
    CancelledOperation,
    #[error("native runner transport deadline exceeded")]
    Timeout,
    #[error("native runner transport IO failed")]
    Io,
    #[error("native runner transport peer closed")]
    PeerEof,
    #[error("native runner transport event capacity exceeded")]
    Capacity,
    #[error("native runner transport protocol failed: {0}")]
    Protocol(ProtocolError),
    #[error("native runner transport was closed by its host")]
    HostClosed,
}
impl From<ProtocolError> for Error {
    fn from(error: ProtocolError) -> Self {
        if error == ProtocolError::Timeout {
            Self::Timeout
        } else {
            Self::Protocol(error)
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub write_timeout_ms: u64,
    pub event_wait_ms: u64,
    pub lifetime_ms: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            write_timeout_ms: 10_000,
            event_wait_ms: 60_000,
            lifetime_ms: MAX_REQUEST_MS,
        }
    }
}
impl Limits {
    pub(crate) fn validate(self) -> Result<(), Error> {
        if [self.write_timeout_ms, self.event_wait_ms, self.lifetime_ms]
            .iter()
            .any(|&value| value == 0 || value > MAX_REQUEST_MS)
        {
            Err(Error::Configuration)
        } else {
            Ok(())
        }
    }
}

/// Host-side commands only; this type is not deserializable from runtime input.
pub enum Command {
    Initialize {
        client_version: String,
        response_timeout_ms: u64,
    },
    Initialized,
    Request {
        method: String,
        params: Value,
        response_timeout_ms: u64,
    },
    Interrupt {
        scope: TurnScope,
        response_timeout_ms: u64,
    },
    RespondApproval {
        response: super::approval::ApprovalResponse,
    },
    RejectServerRequest {
        id: RequestId,
    },
}

/// All bytes were accepted and flushed by the supplied AsyncWrite. This is
/// neither a verified child-stdin ACK nor an RPC or Hagency dispatch result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportWrite {
    pub request_id: Option<RequestId>,
    pub bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnconfirmedWrite {
    pub request_id: Option<RequestId>,
    pub accepted_bytes: usize,
    pub total_bytes: usize,
}

/// Every transport termination needs host reconciliation with the current
/// dispatch/guardian. Counts and byte progress grant no cleanup or replay rights.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Termination {
    pub cause: Error,
    pub unconfirmed_write: Option<UnconfirmedWrite>,
    pub pending_requests: usize,
    pub pending_server_requests: usize,
}

/// Private diagnostic data, deliberately neither Debug nor Serialize.
pub struct StderrSnapshot {
    pub total_bytes: u64,
    pub tail: Vec<u8>,
}

struct Streams<R, W, E> {
    stdout: R,
    stdin: W,
    stderr: E,
}
struct Writing {
    id: Option<RequestId>,
    bytes: Vec<u8>,
    offset: usize,
    flushed: bool,
}

/// A single owner drives all IO. No channels, spawned tasks or external handles
/// are created; stream and process ownership must be established by the host.
pub struct Driver<R, W, E> {
    streams: Option<Streams<R, W, E>>,
    connection: Connection,
    origin: Instant,
    lifetime: Instant,
    limits: Limits,
    input: [u8; READ_BYTES],
    input_start: usize,
    input_end: usize,
    stderr_buffer: [u8; READ_BYTES],
    stderr_open: bool,
    diagnostics: PrivateStderr,
    events: EventQueue,
    writing: Option<Writing>,
    termination: Option<Termination>,
    pending_before_call: (usize, usize),
}

impl<R, W, E> Driver<R, W, E> {
    pub(super) fn pending_server_requests(&self) -> usize {
        self.connection.pending_server_count()
    }
    pub(super) fn ensure_live(&mut self) -> Result<(), Error> {
        let result = self.check(self.lifetime);
        if let Err(error) = result {
            self.stop(error);
        }
        result
    }
    pub(super) fn has_partial_frame(&self) -> bool {
        self.connection.partial_frame_bytes() != 0
    }
    /// Read-only writer progress for host diagnostics: `(accepted, total)` of
    /// the frame currently in the transport, or `None` when nothing is in
    /// flight. Carries no authority, admits no resend, changes no verdict.
    pub(super) fn write_progress(&self) -> Option<(usize, usize)> {
        self.writing
            .as_ref()
            .map(|writing| (writing.offset, writing.bytes.len()))
    }
    /// Whether the connection still holds this prepared server request, i.e.
    /// the one-shot frame's transmit path is alive. False once
    /// `serverRequest/resolved` was parsed for the id.
    pub(super) fn prepared_admissible(&self, id: &RequestId) -> bool {
        self.connection.has_prepared_approval(id)
    }

    /// Drain the transport's received snapshot without reading any more IO.
    /// The session checks partial bytes separately before closing this snapshot.
    pub(super) fn buffered_event(&mut self) -> Result<Option<Event>, Error> {
        self.ensure_live()?;
        if let Some(event) = self.events.pop() {
            return Ok(Some(event));
        }
        while self.input_start < self.input_end {
            let result = self.parse_input();
            if let Err(error) = result {
                self.stop(error);
                return Err(error);
            }
            self.ensure_live()?;
            if let Some(event) = self.events.pop() {
                return Ok(Some(event));
            }
        }
        Ok(None)
    }

    fn parse_input(&mut self) -> Result<(), Error> {
        self.pending_before_call = (
            self.connection.pending_count(),
            self.connection.pending_server_count(),
        );
        let (consumed, event) = self
            .connection
            .receive(&self.input[self.input_start..self.input_end], self.now_ms())
            .map_err(Error::from)?;
        self.input_start += consumed;
        if let Some(event) = event {
            self.events.push(event)?;
        }
        Ok(())
    }

    pub fn new(stdout: R, stdin: W, stderr: E, limits: Limits) -> Result<Self, Error> {
        limits.validate()?;
        let origin = Instant::now();
        let lifetime = origin
            .checked_add(Duration::from_millis(limits.lifetime_ms))
            .ok_or(Error::Configuration)?;
        Ok(Self {
            streams: Some(Streams {
                stdout,
                stdin,
                stderr,
            }),
            connection: Connection::default(),
            origin,
            lifetime,
            limits,
            input: [0; READ_BYTES],
            input_start: 0,
            input_end: 0,
            stderr_buffer: [0; READ_BYTES],
            stderr_open: true,
            diagnostics: PrivateStderr::default(),
            events: EventQueue::default(),
            writing: None,
            termination: None,
            pending_before_call: (0, 0),
        })
    }

    pub fn phase(&self) -> Phase {
        self.connection.phase()
    }
    pub fn termination(&self) -> Option<&Termination> {
        self.termination.as_ref()
    }
    pub fn queued_events(&self) -> usize {
        self.events.len()
    }
    pub fn queued_event_bytes(&self) -> usize {
        self.events.bytes()
    }
    pub fn stderr_snapshot(&self) -> StderrSnapshot {
        self.diagnostics.snapshot()
    }

    fn stop(&mut self, cause: Error) {
        if self.termination.is_some() {
            return;
        }
        let pending = if self.connection.phase() == Phase::Closed {
            self.pending_before_call
        } else {
            (
                self.connection.pending_count(),
                self.connection.pending_server_count(),
            )
        };
        self.termination = Some(Termination {
            cause,
            unconfirmed_write: self.writing.as_ref().map(|writing| UnconfirmedWrite {
                request_id: writing.id.clone(),
                accepted_bytes: writing.offset,
                total_bytes: writing.bytes.len(),
            }),
            pending_requests: pending.0,
            pending_server_requests: pending.1,
        });
        let _ = self.connection.transport_failed();
        self.streams.take();
        self.writing.take();
        self.events.clear();
        self.input_start = 0;
        self.input_end = 0;
    }

    pub fn close(&mut self) {
        self.stop(Error::HostClosed);
    }

    fn now_ms(&self) -> u64 {
        self.origin
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }

    fn check(&mut self, deadline: Instant) -> Result<(), Error> {
        if self.termination.is_some() {
            return Err(Error::Closed);
        }
        if Instant::now() >= deadline || Instant::now() >= self.lifetime {
            return Err(Error::Timeout);
        }
        self.pending_before_call = (
            self.connection.pending_count(),
            self.connection.pending_server_count(),
        );
        self.connection.tick(self.now_ms()).map_err(Error::from)
    }

    fn next_deadline(&self, operation: Instant) -> Instant {
        let protocol = self
            .connection
            .deadline_ms()
            .and_then(|ms| self.origin.checked_add(Duration::from_millis(ms)))
            .unwrap_or(self.lifetime);
        operation.min(self.lifetime).min(protocol)
    }
}

// An async operation must never leave an output offset or unread protocol state
// available for a new operation when the future is dropped by select/timeout.
struct Operation<'a, R, W, E> {
    driver: &'a mut Driver<R, W, E>,
    finished: bool,
}
impl<R, W, E> Drop for Operation<'_, R, W, E> {
    fn drop(&mut self) {
        if !self.finished {
            self.driver.stop(Error::CancelledOperation);
        }
    }
}
impl<R, W, E> Operation<'_, R, W, E> {
    fn finish<T>(mut self, result: Result<T, Error>) -> Result<T, Error> {
        if let Err(error) = &result {
            self.driver.stop(*error);
        }
        self.finished = true;
        result
    }
}

impl<R: AsyncRead + Unpin, W: AsyncWrite + Unpin, E: AsyncRead + Unpin> Driver<R, W, E> {
    pub async fn send(&mut self, command: Command) -> Result<TransportWrite, Error> {
        if self.termination.is_some() {
            return Err(Error::Closed);
        }
        let operation = Operation {
            driver: self,
            finished: false,
        };
        let result = operation.driver.send_inner(command).await;
        operation.finish(result)
    }

    async fn send_inner(&mut self, command: Command) -> Result<TransportWrite, Error> {
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(self.limits.write_timeout_ms))
            .ok_or(Error::Timeout)?;
        self.check(deadline)?;
        let now = self.now_ms();
        let (id, bytes) = match command {
            Command::Initialize {
                client_version,
                response_timeout_ms,
            } => self
                .connection
                .initialize(&client_version, now, response_timeout_ms)
                .map(|(id, bytes)| (Some(id), bytes)),
            Command::Initialized => self.connection.initialized(now).map(|bytes| (None, bytes)),
            Command::Request {
                method,
                params,
                response_timeout_ms,
            } => self
                .connection
                .request(&method, params, now, response_timeout_ms)
                .map(|(id, bytes)| (Some(id), bytes)),
            Command::Interrupt {
                scope,
                response_timeout_ms,
            } => self
                .connection
                .interrupt(scope, now, response_timeout_ms)
                .map(|(id, bytes)| (Some(id), bytes)),
            Command::RespondApproval { response } => self
                .connection
                .respond_approval(response, now)
                .map(|bytes| (None, bytes)),
            Command::RejectServerRequest { id } => self
                .connection
                .reject_server_request(&id, now)
                .map(|bytes| (None, bytes)),
        }
        .map_err(Error::from)?;
        self.writing = Some(Writing {
            id,
            bytes,
            offset: 0,
            flushed: false,
        });
        loop {
            // Even always-ready custom streams must yield to host cancellation.
            tokio::task::yield_now().await;
            self.check(deadline)?;
            if self.writing.as_ref().is_some_and(|w| w.flushed) {
                let writing = self.writing.take().ok_or(Error::Closed)?;
                return Ok(TransportWrite {
                    request_id: writing.id,
                    bytes: writing.bytes.len(),
                });
            }
            self.step(deadline).await?;
        }
    }

    pub async fn next_event(&mut self) -> Result<Event, Error> {
        if self.termination.is_some() {
            return Err(Error::Closed);
        }
        let operation = Operation {
            driver: self,
            finished: false,
        };
        let result = operation.driver.next_inner().await;
        operation.finish(result)
    }

    async fn next_inner(&mut self) -> Result<Event, Error> {
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(self.limits.event_wait_ms))
            .ok_or(Error::Timeout)?;
        loop {
            tokio::task::yield_now().await;
            self.check(deadline)?;
            if let Some(event) = self.events.pop() {
                return Ok(event);
            }
            self.step(deadline).await?;
        }
    }

    async fn step(&mut self, operation_deadline: Instant) -> Result<(), Error> {
        self.check(operation_deadline)?;
        // A frame that has accepted bytes owns the stream until its flush is
        // observed. Parsing first here would let a `serverRequest/resolved` for
        // that very frame be queued between the write and its receipt, which is
        // the ordering the approval middle case depends on not happening.
        let mid_write = self
            .writing
            .as_ref()
            .is_some_and(|w| w.offset != 0 && !w.flushed);
        if !mid_write && self.input_start < self.input_end {
            self.parse_input()?;
            self.check(operation_deadline)?;
            return Ok(());
        }
        let deadline = self.next_deadline(operation_deadline);
        let streams = self.streams.as_mut().ok_or(Error::Closed)?;
        enum Observed {
            Write(std::io::Result<usize>),
            Flush(std::io::Result<()>),
            Read(std::io::Result<usize>),
            Stderr(std::io::Result<usize>),
            Deadline,
        }
        let write_active = self
            .writing
            .as_ref()
            .is_some_and(|w| w.offset < w.bytes.len());
        let flush_active = self
            .writing
            .as_ref()
            .is_some_and(|w| w.offset == w.bytes.len() && !w.flushed);
        // A read may only ever overwrite an EMPTY buffer. F1 lets control reach
        // this select with unparsed bytes still in `input` (mid-write, parse
        // suppressed); without this guard the read arm would reset
        // `input_start`/`input_end` and silently discard them. Mirrors the
        // invariant the old early return used to provide for free.
        let read_ready = self.input_start == self.input_end;
        let observed = tokio::select! {
            _ = tokio::time::sleep_until(deadline) => Observed::Deadline,
            result = async {
                if write_active {
                    match self.writing.as_ref() {
                        Some(writing) => Observed::Write(streams.stdin.write(&writing.bytes[writing.offset..]).await),
                        None => Observed::Write(Err(std::io::Error::other("no write"))),
                    }
                } else { Observed::Flush(streams.stdin.flush().await) }
            }, if write_active || flush_active => result,
            result = streams.stdout.read(&mut self.input), if read_ready => Observed::Read(result),
            result = streams.stderr.read(&mut self.stderr_buffer), if self.stderr_open => Observed::Stderr(result),
        };
        match observed {
            Observed::Deadline => return Err(Error::Timeout),
            Observed::Write(Ok(0)) | Observed::Read(Ok(0)) => return Err(Error::PeerEof),
            Observed::Write(Ok(n)) => {
                let writing = self.writing.as_mut().ok_or(Error::Closed)?;
                writing.offset = writing
                    .offset
                    .checked_add(n)
                    .filter(|&n| n <= writing.bytes.len())
                    .ok_or(Error::Io)?;
            }
            Observed::Flush(Ok(())) => self.writing.as_mut().ok_or(Error::Closed)?.flushed = true,
            Observed::Read(Ok(n)) => {
                self.input_start = 0;
                self.input_end = n;
            }
            Observed::Stderr(Ok(0)) => self.stderr_open = false,
            Observed::Stderr(Ok(n)) => self.diagnostics.append(&self.stderr_buffer[..n])?,
            Observed::Write(Err(_))
            | Observed::Flush(Err(_))
            | Observed::Read(Err(_))
            | Observed::Stderr(Err(_)) => return Err(Error::Io),
        }
        self.check(operation_deadline)
    }
}

#[cfg(test)]
mod hold_tests {
    //! The F1 hold: unparsed input survives a mid-write read window.
    use super::*;
    use crate::codex::approval::ApprovalRequest;
    use serde_json::{Value, json};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
    use tokio::time::{Instant, sleep, timeout};

    fn limits() -> Limits {
        Limits {
            write_timeout_ms: 10_000,
            event_wait_ms: 1_000,
            lifetime_ms: 30_000,
        }
    }
    fn line(value: Value) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        bytes
    }
    async fn read_byte_line(reader: &mut DuplexStream) -> Vec<u8> {
        timeout(Duration::from_secs(3), async {
            let mut bytes = Vec::new();
            loop {
                let byte = reader.read_u8().await.unwrap();
                bytes.push(byte);
                if byte == b'\n' {
                    return bytes;
                }
            }
        })
        .await
        .unwrap()
    }
    fn approval_params() -> Value {
        json!({"threadId":"owned-thread","turnId":"owned-turn","itemId":"approval-1",
            "startedAtMs":1,"command":"echo x","cwd":"/tmp"})
    }

    /// The peer's stdout delivers `serverRequest/resolved` for the in-flight
    /// id while the frame has accepted bytes and is not yet flushed (the
    /// duplex(16) stdin keeps the write pending until the peer drains it),
    /// more stdout bytes arrive before the flush, and after the flush every
    /// byte is parsed in order with nothing lost: the resolution is delivered
    /// after the receipt, then the extra line. A read may only ever
    /// overwrite an empty buffer — the invariant the guarded read arm
    /// preserves; without the guard the second stdout read would reset
    /// `input_start`/`input_end` over the unparsed resolution and destroy it.
    #[tokio::test(start_paused = true)]
    async fn native_transport_hold_keeps_unparsed_input() {
        // stdin capacity 16: the 52-byte frame cannot fully fit, so the write
        // stays mid-flight (accepted, unflushed) until the peer drains it.
        let (stdin_host, mut peer_in) = tokio::io::duplex(16);
        let (stdout_host, mut peer_out) = tokio::io::duplex(65536);
        let (stderr_host, _peer_err) = tokio::io::duplex(1024);
        let mut driver = Driver::new(stdout_host, stdin_host, stderr_host, limits()).unwrap();
        let peer_task = tokio::spawn(async move {
            read_byte_line(&mut peer_in).await;
            peer_out
                .write_all(&line(json!({ "id": 0, "result": {
                    "userAgent": "fixture/0.153.4", "platformFamily": "unix",
                    "platformOs": "macos", "codexHome": "/fixture"
                } })))
                .await
                .unwrap();
            read_byte_line(&mut peer_in).await; // initialized notification
            peer_out
                .write_all(&line(json!({
                    "id": "approval-1", "method": "item/commandExecution/requestApproval",
                    "params": approval_params()
                })))
                .await
                .unwrap();
            // Hold the frame mid-write: take a prefix so the pipe is full and
            // the driver's write arm stays pending with accepted bytes.
            let mut head = vec![0u8; 8];
            peer_in.read_exact(&mut head).await.unwrap();
            // The resolution for the in-flight id, then one more line, both
            // while the frame is accepted-but-unflushed.
            peer_out
                .write_all(&line(json!({"method":"serverRequest/resolved","params":{
                    "threadId":"owned-thread","requestId":"approval-1"}})))
                .await
                .unwrap();
            peer_out
                .write_all(&line(json!({"method":"fixture/extra","params":{"n":1}})))
                .await
                .unwrap();
            // Let the driver poll once in this state: input non-empty,
            // mid-write, stdout readable. Only the guard keeps the read arm
            // from overwriting the buffered resolution bytes.
            sleep(Duration::from_millis(10)).await;
            // Drain the rest of the frame so the write can flush.
            let mut tail = Vec::new();
            while tail.last() != Some(&b'\n') {
                tail.push(peer_in.read_u8().await.unwrap());
            }
            let mut frame = head;
            frame.append(&mut tail);
            frame
        });
        // Handshake to Ready, then receive the approval request.
        driver
            .send(Command::Initialize {
                client_version: "0.1".into(),
                response_timeout_ms: 1_000,
            })
            .await
            .unwrap();
        assert!(matches!(
            driver.next_event().await,
            Ok(Event::Initialized { .. })
        ));
        driver.send(Command::Initialized).await.unwrap();
        assert!(matches!(
            driver.next_event().await,
            Ok(Event::ServerRequest { .. })
        ));
        assert_eq!(driver.phase(), Phase::Ready);
        // Prepare the one-shot decline and drive the prepared send through
        // the mid-write window above.
        let request = ApprovalRequest::parse(
            RequestId::String("approval-1".into()),
            "item/commandExecution/requestApproval".into(),
            approval_params(),
        )
        .unwrap();
        let mut prepared = driver
            .prepare_approval(
                request.response(false),
                Instant::now() + Duration::from_secs(5),
            )
            .unwrap();
        let receipt = match driver.send_prepared_or_event(&mut prepared).await.unwrap() {
            Controlled::Control(write) => write,
            Controlled::Event(_) => panic!("resolution must not preempt the frame"),
        };
        let frame = timeout(Duration::from_secs(3), peer_task)
            .await
            .unwrap()
            .unwrap();
        // The receipt covers the whole frame and the peer read exactly the
        // prepared bytes, in order, with nothing overwritten.
        assert_eq!(receipt.bytes, frame.len());
        assert_eq!(
            receipt.request_id,
            Some(RequestId::String("approval-1".into()))
        );
        let sent = serde_json::from_slice::<Value>(&frame).unwrap();
        assert_eq!(sent["id"], "approval-1");
        assert_eq!(sent["result"]["decision"], "decline");
        // After the receipt, the unparsed input parses in arrival order:
        // the resolution first, then the extra line. Nothing was lost.
        match driver.next_event().await {
            Ok(Event::Notification { method, .. }) => assert_eq!(method, "serverRequest/resolved"),
            _ => panic!("resolution lost or reordered"),
        }
        match driver.next_event().await {
            Ok(Event::Notification { method, .. }) => assert_eq!(method, "fixture/extra"),
            _ => panic!("extra line lost or reordered"),
        }
    }
}
