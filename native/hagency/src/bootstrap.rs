//! Explicit one-attempt development startup; no production scheduler or file tool.
mod config;
mod driver;
mod workspace;
use hagency_matrix::CancellationToken;
use hagency_store::{DomainRepository, DomainStore, Repository, Store, private};
use salvo::prelude::*;
use serde::Serialize;
use std::{
    net::SocketAddr,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Failure {
    #[error("development profile is invalid or unavailable")]
    Config,
    #[error("native startup owner is unavailable")]
    Startup,
    #[error("current Matrix refresh was refused")]
    Refresh,
    #[error("workspace registration is unavailable")]
    Registration,
    #[error("development attempt was cancelled")]
    Cancelled,
    #[error("development worker is unavailable")]
    Worker,
    #[error("original owned outcome is unknown; owner retained")]
    OutcomeUnknown,
    #[error("native server failed")]
    Server,
}
#[derive(Clone, Serialize)]
pub struct Status {
    mode: &'static str,
    state: &'static str,
    workspace_registered: bool,
    protocol: Option<&'static str>,
    cleanup: Option<&'static str>,
    settlement: Option<&'static str>,
    error: Option<&'static str>,
}
#[derive(Clone)]
pub(crate) struct StatusHandle(Arc<Mutex<Status>>);
impl StatusHandle {
    fn new(enabled: bool) -> Self {
        Self(Arc::new(Mutex::new(Status {
            mode: if enabled { "one_attempt" } else { "disabled" },
            state: if enabled { "prepared" } else { "disabled" },
            workspace_registered: false,
            protocol: None,
            cleanup: None,
            settlement: None,
            error: None,
        })))
    }
    pub(crate) fn get(&self) -> Status {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn phase(&self, phase: &'static str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).state = phase;
    }
    fn registered(&self) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .workspace_registered = true;
    }
    fn fail(&self, failure: Failure) {
        let mut status = self.0.lock().unwrap_or_else(|e| e.into_inner());
        status.state = if matches!(failure, Failure::OutcomeUnknown | Failure::Worker) {
            "outcome_unknown"
        } else {
            "unavailable"
        };
        status.error = Some(match failure {
            Failure::Config => "config",
            Failure::Startup => "startup",
            Failure::Refresh => "refresh",
            Failure::Registration => "registration",
            Failure::Cancelled => "cancelled",
            Failure::Worker => "worker",
            Failure::OutcomeUnknown => "outcome_unknown",
            Failure::Server => "server",
        });
    }
    fn result(&self, report: &hagency_execution::Report) {
        use hagency_execution::{Protocol, Settlement};
        use hagency_runtime::owned::Cleanup;
        let mut status = self.0.lock().unwrap_or_else(|e| e.into_inner());
        status.protocol = Some(match report.protocol {
            Protocol::NotStarted => "not_started",
            Protocol::Completed => "completed",
            Protocol::Failed => "failed",
            Protocol::Interrupted => "interrupted",
            Protocol::Unsupported => "unsupported",
            Protocol::Unknown => "unknown",
        });
        status.cleanup = Some(match report.cleanup {
            Cleanup::Pending => "pending",
            Cleanup::Observed(v) if v.scope.whole_tree_stopped => "whole_tree_stopped",
            _ => "unknown",
        });
        status.settlement = Some(match report.settlement {
            Settlement::Pending => "pending",
            Settlement::Completed => "completed",
            Settlement::CanonicalReplyReady => "canonical_reply_ready",
            Settlement::Negative(_) => "negative",
            Settlement::Unknown => "unknown",
        });
        status.state = if report.failure.is_none() {
            "completed"
        } else {
            "outcome_unknown"
        };
        if report.failure.is_some() {
            status.error = Some("owned_attempt");
        }
    }
}
pub struct Bootstrap {
    store: Store,
    domain: DomainStore,
    app: crate::App,
    listen: SocketAddr,
    prepared: Option<config::Prepared>,
    driver: Option<driver::Driver>,
    status: StatusHandle,
    domain_closed: bool,
    store_closed: bool,
}
impl Bootstrap {
    /// Own fresh development state. No live repository, .env, arbitrary command
    /// or raw runner capability is accepted from configuration or HTTP.
    pub fn open(
        state: &Path,
        listen: SocketAddr,
        queue_capacity: usize,
        development: bool,
    ) -> Result<Self, Failure> {
        if !listen.ip().is_loopback() || listen.port() == 0 {
            return Err(Failure::Config);
        }
        private::directory(state).map_err(|_| Failure::Startup)?;
        let state = state.canonicalize().map_err(|_| Failure::Startup)?;
        let token =
            private::read_secret(&state.join("operator.token")).map_err(|_| Failure::Startup)?;
        let prepared = if development {
            Some(config::Prepared::load(&state, listen)?)
        } else {
            None
        };
        let store = Store::start(
            Repository::open(&state).map_err(|_| Failure::Startup)?,
            queue_capacity,
        )
        .map_err(|_| Failure::Startup)?;
        let domain = DomainStore::start(
            DomainRepository::open(&state).map_err(|_| Failure::Startup)?,
            queue_capacity,
        )
        .map_err(|_| Failure::Startup)?;
        let status = StatusHandle::new(development);
        let app = crate::App::new(store.clone(), &token, listen)
            .map_err(|_| Failure::Startup)?
            .with_domain(domain.clone())
            .with_development(status.clone());
        Ok(Self {
            store,
            domain,
            app,
            listen,
            prepared,
            driver: None,
            status,
            domain_closed: false,
            store_closed: false,
        })
    }
    pub fn status(&self) -> Status {
        self.status.get()
    }
    /// Borrowing close retains this original owner/writer wrapper on failure.
    /// Driver receipts stay inspectable; the existing writer shutdown API may
    /// return an unknown final outcome. Neither wrapper presence nor timeout
    /// proves its repository remains open or has closed. Retain this Bootstrap.
    pub async fn close(&mut self) -> Result<(), Failure> {
        if let Some(driver) = &mut self.driver {
            driver.close().await?;
        }
        if !self.domain_closed {
            self.domain
                .shutdown()
                .await
                .map_err(|_| Failure::OutcomeUnknown)?;
            self.domain_closed = true;
        }
        if !self.store_closed {
            self.store
                .shutdown()
                .await
                .map_err(|_| Failure::OutcomeUnknown)?;
            self.store_closed = true;
        }
        self.status.phase("closed");
        Ok(())
    }
    pub async fn serve(&mut self, shutdown: &CancellationToken) -> Result<(), Failure> {
        let acceptor = TcpListener::new(self.listen)
            .try_bind()
            .await
            .map_err(|_| Failure::Server)?;
        let server = Server::new(acceptor).max_connections(64);
        let handle = server.handle();
        let mut serving = Box::pin(server.try_serve(self.app.clone().router()));
        // Poll the real server first. Its listener/router exist before any child
        // or helper can try to connect; no fixture-only readiness setter.
        tokio::select! { biased; result=&mut serving=>{result.map_err(|_|Failure::Server)?;return Err(Failure::Server);}, _=tokio::task::yield_now()=>{} }
        if let Some(prepared) = self.prepared.take() {
            self.driver = Some(driver::Driver::start(
                prepared,
                self.domain.clone(),
                self.status.clone(),
            )?);
        }
        tracing::info!("native service ready; production Agent execution remains unavailable");
        tokio::select! {
            result=&mut serving=>{ result.map_err(|_|Failure::Server)?; return Err(Failure::Server); },
            _=shutdown.cancelled()=>{}
        }
        if let Some(driver) = &self.driver {
            driver.cancel();
        }
        let outcome = tokio::select! {
            result=&mut serving=>{result.map_err(|_|Failure::Server)?;return Err(Failure::Server);},
            result=self.close()=>result,
        };
        if outcome.is_err() {
            self.status.fail(Failure::OutcomeUnknown);
            tracing::error!("native shutdown incomplete; original owner retained");
            // Keep the authenticated fixed status endpoint and the original
            // owner. No automatic close/claim retry or false successful exit.
            return serving
                .await
                .map_err(|_| Failure::Server)
                .and(Err(Failure::OutcomeUnknown));
        }
        handle.stop_graceful(Some(Duration::from_secs(5)));
        serving.await.map_err(|_| Failure::Server)
    }
}
