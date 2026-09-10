use super::state::{State, scope};
use super::{
    Error, InterruptDisposition, MAX_DEFERRED, MAX_DEFERRED_BYTES, MAX_TEXT_BYTES, Outcome, Phase,
    ResumeThreadId, Settings, Update,
};
use crate::codex::{Event, MAX_REQUEST_MS, RequestId, TurnScope, transport};
use serde_json::Value;
use std::collections::VecDeque;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{Instant, timeout_at};

/// One disposable upstream turn. The host supplies already-owned streams and
/// separately holds all process, Hagency task, approval and lease authority.
pub struct SessionDriver<R, W, E> {
    wire: transport::Driver<R, W, E>,
    settings: Settings,
    state: State,
    response_timeout_ms: u64,
    deferred: VecDeque<Event>,
    deferred_bytes: usize,
}

impl<R, W, E> SessionDriver<R, W, E> {
    pub fn new(
        stdout: R,
        stdin: W,
        stderr: E,
        settings: Settings,
        limits: transport::Limits,
        response_timeout_ms: u64,
    ) -> Result<Self, Error> {
        if response_timeout_ms == 0 || response_timeout_ms > MAX_REQUEST_MS {
            return Err(Error::Settings);
        }
        Ok(Self {
            wire: transport::Driver::new(stdout, stdin, stderr, limits)
                .map_err(Error::Transport)?,
            settings,
            state: State::default(),
            response_timeout_ms,
            deferred: VecDeque::new(),
            deferred_bytes: 0,
        })
    }
    pub fn phase(&self) -> Phase {
        self.state.phase
    }
    pub fn thread_id(&self) -> Option<&str> {
        self.state.thread.as_deref()
    }
    pub fn turn_id(&self) -> Option<&str> {
        self.state.turn.as_deref()
    }
    pub fn outcome(&self) -> Option<&Outcome> {
        self.state.outcome.as_ref()
    }
    pub fn item_count(&self) -> usize {
        self.state.item_count()
    }
    pub fn text_bytes(&self) -> usize {
        self.state.text_bytes()
    }
    pub fn event_count(&self) -> usize {
        self.state.event_count()
    }
    pub fn transport_termination(&self) -> Option<&transport::Termination> {
        self.wire.termination()
    }
    pub fn stderr_snapshot(&self) -> transport::StderrSnapshot {
        self.wire.stderr_snapshot()
    }

    pub fn close(&mut self) {
        if self.state.phase != Phase::Ended {
            self.fail(Error::Cancelled);
        }
        self.wire.close();
    }
    fn fail(&mut self, error: Error) {
        self.state.failed(error);
        self.wire.close();
        self.deferred.clear();
        self.deferred_bytes = 0;
    }
    fn buffer(&mut self, event: Event) -> Result<(), Error> {
        let Event::Notification {
            method,
            params: Some(params),
        } = &event
        else {
            return Err(Error::Malformed);
        };
        // A new thread is unbound until its RPC response. Only thread lifecycle
        // and global notices may race that response; no turn is admitted yet.
        if self.state.phase == Phase::OpeningThread
            && !matches!(
                method.as_str(),
                "thread/started" | "thread/status/changed" | "warning" | "configWarning"
            )
        {
            return Err(Error::Scope);
        }
        scope(
            method,
            params,
            self.state.thread.as_deref(),
            self.state.turn.as_deref(),
        )?;
        let charge = transport::event_bytes(&event).map_err(Error::Transport)?;
        let total = self
            .deferred_bytes
            .checked_add(charge)
            .filter(|&n| n <= MAX_DEFERRED_BYTES)
            .ok_or(Error::Capacity)?;
        if self.deferred.len() >= MAX_DEFERRED {
            return Err(Error::Capacity);
        }
        self.deferred.push_back(event);
        self.deferred_bytes = total;
        Ok(())
    }
    fn validate_deferred(&self) -> Result<(), Error> {
        for event in &self.deferred {
            let Event::Notification {
                method,
                params: Some(params),
            } = event
            else {
                return Err(Error::Malformed);
            };
            scope(
                method,
                params,
                self.state.thread.as_deref(),
                self.state.turn.as_deref(),
            )?;
        }
        Ok(())
    }
    fn pop(&mut self) -> Result<Option<Event>, Error> {
        let Some(event) = self.deferred.pop_front() else {
            return Ok(None);
        };
        self.deferred_bytes = self
            .deferred_bytes
            .checked_sub(transport::event_bytes(&event).map_err(Error::Transport)?)
            .ok_or(Error::Capacity)?;
        Ok(Some(event))
    }
}

// Dropping any started operation poisons the typed state even when cancellation
// happens between lower-level IO calls. Closing streams does not stop a child.
struct Operation<'a, R, W, E> {
    session: &'a mut SessionDriver<R, W, E>,
    finished: bool,
}
impl<R, W, E> Drop for Operation<'_, R, W, E> {
    fn drop(&mut self) {
        if !self.finished {
            self.session.fail(Error::Cancelled);
        }
    }
}
impl<R, W, E> Operation<'_, R, W, E> {
    fn finish<T>(mut self, result: Result<T, Error>) -> Result<T, Error> {
        if let Err(error) = result.as_ref() {
            self.session.fail(*error);
        }
        self.finished = true;
        result
    }
}

impl<R: AsyncRead + Unpin, W: AsyncWrite + Unpin, E: AsyncRead + Unpin> SessionDriver<R, W, E> {
    pub async fn initialize(&mut self) -> Result<(), Error> {
        if self.phase() != Phase::New {
            return Err(Error::State);
        }
        let operation = Operation {
            session: self,
            finished: false,
        };
        let result = operation.session.initialize_inner().await;
        operation.finish(result)
    }
    async fn initialize_inner(&mut self) -> Result<(), Error> {
        self.state.phase = Phase::Initializing;
        self.wire
            .send(transport::Command::Initialize {
                client_version: env!("CARGO_PKG_VERSION").into(),
                response_timeout_ms: self.response_timeout_ms,
            })
            .await
            .map_err(Error::Transport)?;
        loop {
            match self.receive().await? {
                Event::Initialized { .. } => break,
                Event::Notification {
                    method,
                    params: Some(params),
                } if matches!(method.as_str(), "warning" | "configWarning") => {
                    self.state.notification(&method, &params)?;
                }
                _ => return Err(Error::Scope),
            }
        }
        self.wire
            .send(transport::Command::Initialized)
            .await
            .map_err(Error::Transport)?;
        self.state.phase = Phase::Ready;
        Ok(())
    }

    pub async fn start_thread(&mut self) -> Result<String, Error> {
        self.open_thread(None).await
    }
    /// Explicit host-recorded upstream identity only; this never authorizes
    /// automatic resume/replay of a Hagency dispatch or an unknown prior turn.
    pub async fn resume_thread(&mut self, id: ResumeThreadId) -> Result<String, Error> {
        self.open_thread(Some(id)).await
    }
    async fn open_thread(&mut self, resume: Option<ResumeThreadId>) -> Result<String, Error> {
        if self.phase() != Phase::Ready {
            return Err(Error::State);
        }
        let operation = Operation {
            session: self,
            finished: false,
        };
        let result = operation
            .session
            .open_thread_inner(resume.as_ref().map(|id| id.0.as_str()))
            .await;
        operation.finish(result)
    }
    async fn open_thread_inner(&mut self, resume: Option<&str>) -> Result<String, Error> {
        self.state.phase = Phase::OpeningThread;
        // For resume, reject a substituted notification even before its response.
        self.state.thread = resume.map(str::to_owned);
        let method = if resume.is_some() {
            "thread/resume"
        } else {
            "thread/start"
        };
        let result = self
            .call(method, self.settings.thread_request(resume))
            .await?;
        let id = self.state.observe_thread(&result, &self.settings, resume)?;
        self.validate_deferred()?;
        while let Some(event) = self.pop()? {
            if let Event::Notification {
                method,
                params: Some(params),
            } = event
            {
                self.state.notification(&method, &params)?;
            }
        }
        Ok(id)
    }

    pub async fn start_turn(&mut self, input: String) -> Result<String, Error> {
        if self.phase() != Phase::ThreadReady {
            return Err(Error::State);
        }
        if input.is_empty() || input.len() > MAX_TEXT_BYTES {
            return Err(Error::Settings);
        }
        let operation = Operation {
            session: self,
            finished: false,
        };
        let result = operation.session.start_turn_inner(input).await;
        operation.finish(result)
    }
    async fn start_turn_inner(&mut self, input: String) -> Result<String, Error> {
        self.state.phase = Phase::StartingTurn;
        let thread = self.state.thread.as_deref().ok_or(Error::State)?;
        let result = self
            .call("turn/start", self.settings.turn_request(thread, input))
            .await?;
        let id = self.state.observe_turn(&result)?;
        self.validate_deferred()?;
        Ok(id)
    }

    pub async fn interrupt(&mut self) -> Result<InterruptDisposition, Error> {
        if self.phase() != Phase::Running || self.state.interrupt_sent {
            return Err(Error::State);
        }
        let operation = Operation {
            session: self,
            finished: false,
        };
        let result = operation.session.interrupt_inner().await;
        operation.finish(result)
    }
    async fn interrupt_inner(&mut self) -> Result<InterruptDisposition, Error> {
        self.state.interrupt_sent = true;
        let scope = TurnScope::new(
            self.state.thread.clone().ok_or(Error::State)?,
            self.state.turn.clone().ok_or(Error::State)?,
        )
        .map_err(|_| Error::Scope)?;
        self.wire
            .send(transport::Command::Interrupt {
                scope: scope.clone(),
                response_timeout_ms: self.response_timeout_ms,
            })
            .await
            .map_err(Error::Transport)?;
        loop {
            match self.receive().await? {
                Event::InterruptAcknowledged { scope: observed } if observed == scope => {
                    return Ok(InterruptDisposition::Acknowledged);
                }
                Event::InterruptRejected {
                    scope: observed,
                    error,
                } if observed == scope => {
                    return Ok(InterruptDisposition::Rejected { code: error.code });
                }
                event @ Event::Notification { .. } => self.buffer(event)?,
                _ => return Err(Error::Scope),
            }
        }
    }

    pub async fn next_update(&mut self) -> Result<Update, Error> {
        if self.phase() != Phase::Running {
            return Err(Error::State);
        }
        let operation = Operation {
            session: self,
            finished: false,
        };
        let result = operation.session.update_inner().await;
        operation.finish(result)
    }
    async fn update_inner(&mut self) -> Result<Update, Error> {
        self.wire.ensure_live().map_err(Error::Transport)?;
        let event = match self.pop()? {
            Some(event) => event,
            None => self.receive().await?,
        };
        let Event::Notification {
            method,
            params: Some(params),
        } = event
        else {
            return Err(Error::Scope);
        };
        let update = self.state.notification(&method, &params)?;
        if self.phase() == Phase::Ended {
            self.drain_terminal().await?;
            self.wire.close();
        }
        Ok(update)
    }

    async fn drain_terminal(&mut self) -> Result<(), Error> {
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(self.response_timeout_ms))
            .ok_or(Error::Transport(transport::Error::Timeout))?;
        loop {
            // Finish an already-started suffix frame, but never start a read
            // when the received snapshot is empty. Fragmentation alone must not
            // make a normal completed + idle stream fail. The whole drain has
            // one absolute deadline, in addition to transport deadlines.
            tokio::task::yield_now().await;
            self.wire.ensure_live().map_err(Error::Transport)?;
            if Instant::now() >= deadline {
                return Err(Error::Transport(transport::Error::Timeout));
            }
            let mut event = match self.pop()? {
                Some(event) => Some(event),
                None => self.wire.buffered_event().map_err(Error::Transport)?,
            };
            if event.is_none() && self.wire.has_partial_frame() {
                event = Some(
                    timeout_at(deadline, self.receive())
                        .await
                        .map_err(|_| Error::Transport(transport::Error::Timeout))??,
                );
            }
            match event {
                Some(Event::Notification {
                    method,
                    params: Some(params),
                }) => self.state.terminal_suffix(&method, &params)?,
                Some(Event::ServerRequest { id, .. }) => {
                    self.unsupported(id).await?;
                }
                Some(_) => return Err(Error::Scope),
                None => break,
            }
        }
        if self.wire.pending_server_requests() > 0 {
            return Err(Error::UnsupportedRequest);
        }
        Ok(())
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, Error> {
        let written = self
            .wire
            .send(transport::Command::Request {
                method: method.into(),
                params,
                response_timeout_ms: self.response_timeout_ms,
            })
            .await
            .map_err(Error::Transport)?;
        let expected = written.request_id.ok_or(Error::State)?;
        loop {
            match self.receive().await? {
                Event::Response {
                    id,
                    method: observed,
                    result,
                } if id == expected && observed == method => {
                    return result.map_err(|error| Error::Rejected(error.code));
                }
                event @ Event::Notification { .. } => self.buffer(event)?,
                _ => return Err(Error::Scope),
            }
        }
    }
    async fn receive(&mut self) -> Result<Event, Error> {
        let event = self.wire.next_event().await.map_err(Error::Transport)?;
        if let Event::ServerRequest { id, .. } = event {
            return self.unsupported(id).await;
        }
        Ok(event)
    }
    async fn unsupported(&mut self, id: RequestId) -> Result<Event, Error> {
        self.wire
            .send(transport::Command::RejectServerRequest { id })
            .await
            .map_err(Error::Transport)?;
        Err(Error::UnsupportedRequest)
    }
}
