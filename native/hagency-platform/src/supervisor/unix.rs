use super::{StopCause, SupervisedReport};
use crate::{Launch, OwnedProcess, StopReport};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    io,
    net::Shutdown,
    os::{fd::OwnedFd, unix::net::UnixStream},
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
mod pipe;
use pipe::{FRAME_LIMIT, Pipe};

// Private wire data on an anonymous inherited socket. Deserialization is not
// runner authorization: only this child's host endpoint can send these messages.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    executable: OsString,
    arguments: Vec<OsString>,
    directory: OsString,
    environment: Vec<(OsString, OsString)>,
    require_crash_containment: bool,
}
impl Configuration {
    fn from_launch(launch: &Launch) -> Self {
        Self {
            executable: launch.executable.as_os_str().into(),
            arguments: launch.arguments.clone(),
            directory: launch.directory.as_os_str().into(),
            environment: launch
                .environment
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            require_crash_containment: launch.require_crash_containment,
        }
    }
    fn into_launch(self) -> io::Result<Launch> {
        let count = self.environment.len();
        let environment: BTreeMap<_, _> = self.environment.into_iter().collect();
        if count != environment.len() {
            return Err(crate::invalid());
        }
        let launch = Launch {
            executable: self.executable.into(),
            arguments: self.arguments,
            directory: self.directory.into(),
            environment,
            require_crash_containment: self.require_crash_containment,
        };
        launch.validate()?;
        if launch.require_crash_containment {
            return Err(unsupported());
        }
        Ok(launch)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Prepare { version: u32, launch: Configuration },
    Start,
    Stop,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Reply {
    Prepared {
        version: u32,
    },
    Started {
        pid: u32,
    },
    Failed,
    Stopped {
        cause: StopCause,
        leader_exited: bool,
        signals_accepted: bool,
        whole_tree_stopped: bool,
    },
}
fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "POSIX detached descendant crash containment is not implemented",
    )
}

pub(super) struct Supervisor {
    child: Child,
    pipe: Pipe,
    pid: u32,
    stop_requested: bool,
    report: Option<SupervisedReport>,
}
impl Supervisor {
    pub(super) fn spawn(guardian: &Path, launch: &Launch) -> io::Result<Self> {
        if launch.require_crash_containment {
            return Err(unsupported());
        }
        let configuration = Configuration::from_launch(launch);
        let (owner, worker) = UnixStream::pair()?;
        let input: OwnedFd = worker.into();
        // The socket is unnamed and only inherited as stdin by this guardian.
        // Work receives null stdin and cannot retain the owner endpoint.
        let child = Command::new(guardian)
            .arg("guardian")
            .env_clear()
            .env("PATH", "")
            .current_dir(&launch.directory)
            .stdin(Stdio::from(input))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let mut result = Self {
            child,
            pipe: Pipe::new(owner),
            pid: 0,
            stop_requested: false,
            report: None,
        };
        let until = Instant::now() + Duration::from_secs(5);
        result.pipe.send(
            &Request::Prepare {
                version: 1,
                launch: configuration,
            },
            until,
        )?;
        if !matches!(
            result.pipe.required::<Reply>(until, 1024)?,
            Reply::Prepared { version: 1 }
        ) {
            return Err(protocol_error());
        }
        result.pipe.send(&Request::Start, until)?;
        match result.pipe.required::<Reply>(until, 1024)? {
            Reply::Started { pid } if pid > 1 => result.pid = pid,
            _ => return Err(io::Error::other("native guardian launch failed")),
        }
        Ok(result)
    }
    pub(super) fn id(&self) -> u32 {
        self.pid
    }
    pub(super) fn wait(&mut self, timeout: Duration) -> io::Result<Option<SupervisedReport>> {
        if self.report.is_some() {
            return Ok(self.report);
        }
        if let Some(reply) = self.pipe.receive::<Reply>(Instant::now() + timeout, 1024)? {
            match reply {
                Reply::Stopped {
                    cause,
                    leader_exited,
                    signals_accepted,
                    whole_tree_stopped,
                } => {
                    // This backend has no complete detached-child proof. Refuse
                    // an impossible stronger report rather than forwarding it.
                    if whole_tree_stopped {
                        return Err(protocol_error());
                    }
                    self.report = Some(SupervisedReport {
                        cause,
                        scope: StopReport {
                            leader_exited,
                            signals_accepted,
                            whole_tree_stopped,
                        },
                    });
                }
                _ => return Err(protocol_error()),
            }
        }
        Ok(self.report)
    }
    pub(super) fn stop(&mut self, timeout: Duration) -> io::Result<SupervisedReport> {
        if let Some(report) = self.report {
            return Ok(report);
        }
        let until = Instant::now() + timeout;
        if !self.stop_requested {
            self.stop_requested = true;
            if let Err(error) = self.pipe.send(&Request::Stop, until) {
                // A natural-exit report may already be buffered after peer EOF.
                if !matches!(
                    error.kind(),
                    io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
                ) {
                    return Err(error);
                }
            }
        }
        self.wait(until.saturating_duration_since(Instant::now()))?
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "guardian cleanup outcome is unknown",
                )
            })
    }
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.pipe.stream.shutdown(Shutdown::Both);
        // EOF authorizes cleanup, not killing the guardian. Retain its independent
        // execution if observation times out; a forced kill could strand work.
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => {}
            }
            if Instant::now() >= until {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
fn protocol_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "unexpected guardian protocol state",
    )
}

/// Run only as an independent native guardian process. stdin must be the
/// inherited anonymous Unix socket. No repository, runtime token or TCP listener.
pub fn run_guardian() -> io::Result<()> {
    // CLOEXEC is essential: a runner must never inherit a descriptor that can
    // impersonate guardian replies to its host. stdin itself is replaced with
    // /dev/null during the scoped child spawn.
    let input = rustix::io::fcntl_dupfd_cloexec(std::io::stdin(), 3)?;
    let mut pipe = Pipe::new(UnixStream::from(input));
    let until = Instant::now() + Duration::from_secs(5);
    let Request::Prepare { version: 1, launch } = pipe.required::<Request>(until, FRAME_LIMIT)?
    else {
        return Err(protocol_error());
    };
    let launch = launch.into_launch()?;
    pipe.send(&Reply::Prepared { version: 1 }, until)?;
    if !matches!(pipe.required::<Request>(until, 1024)?, Request::Start) {
        return Err(protocol_error());
    }
    let mut process = match OwnedProcess::spawn(&launch) {
        Ok(process) => process,
        Err(error) => {
            let _ = pipe.send(&Reply::Failed, Instant::now() + Duration::from_secs(1));
            return Err(error);
        }
    };
    // If the owner disappeared during spawn, failed notification drops the
    // owned scope. Work has never existed without a live guardian owner.
    pipe.send(
        &Reply::Started { pid: process.id() },
        Instant::now() + Duration::from_secs(1),
    )?;
    let cause = loop {
        match pipe.receive::<Request>(Instant::now() + Duration::from_millis(25), 1024) {
            Ok(Some(Request::Stop)) => break StopCause::Requested,
            Ok(Some(_)) => break StopCause::ProtocolFailure,
            Ok(None) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset
                ) =>
            {
                break StopCause::OwnerLost;
            }
            Err(_) => break StopCause::ProtocolFailure,
        }
        match process.is_leader_running() {
            Ok(true) => {}
            Ok(false) => break StopCause::LeaderExited,
            Err(_) => break StopCause::ObservationFailure,
        }
    };
    let report = process.stop(Duration::from_secs(2))?;
    let _ = pipe.send(
        &Reply::Stopped {
            cause,
            leader_exited: report.leader_exited,
            signals_accepted: report.signals_accepted,
            whole_tree_stopped: report.whole_tree_stopped,
        },
        Instant::now() + Duration::from_secs(1),
    );
    if report.whole_tree_stopped {
        Ok(())
    } else {
        Err(io::Error::other("complete descendant cleanup is unproven"))
    }
}
