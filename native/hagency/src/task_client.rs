//! Native maintenance of one already-assigned task through the scoped API.
use hagency_core::{
    JSON_SAFE_MAX,
    project::identifier,
    tasks::{MutationResult, RunnerCapability, Task, TaskMutation, TaskState, TextPatch, text},
};
use http_body_util::{BodyExt, Full};
use hyper::{Request, body::Bytes, client::conn::http1};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use serde_json::json;
use std::{net::SocketAddr, time::Duration};
use tokio::{net::TcpStream, time::timeout};

const RESPONSE_LIMIT: usize = 64 * 1024;
const REQUEST_LIMIT: usize = 16 * 1024;
pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("invalid native task command or runner context")]
    Invalid,
    #[error("native task service unavailable before request submission")]
    Unavailable,
    #[error("task operation outcome unknown; inspect or retry identical call ID and content")]
    Unknown,
    #[error("native task request was refused (HTTP {0})")]
    Refused(u16),
    #[error("native task response is invalid or exceeds its limit")]
    Response,
}

/// Host-provisioned inherited context. No Debug/Serialize or on-disk format.
pub struct Context {
    address: SocketAddr,
    capability: RunnerCapability,
    task_id: String,
}
impl Context {
    pub fn new(
        address: SocketAddr,
        capability: RunnerCapability,
        task_id: String,
    ) -> Result<Self, Error> {
        if !address.ip().is_loopback()
            || address.port() == 0
            || matches!(address,SocketAddr::V6(v) if v.scope_id()!=0 || v.flowinfo()!=0)
            || capability.fence == 0
            || capability.fence > JSON_SAFE_MAX
            || capability.secret.len() != 64
            || !capability.secret.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(Error::Invalid);
        }
        for id in [&capability.dispatch_id, &capability.runner_id, &task_id] {
            identifier(id, 128).map_err(|_| Error::Invalid)?;
        }
        Ok(Self {
            address,
            capability,
            task_id,
        })
    }
    pub fn from_env() -> Result<Self, Error> {
        let get = |name, max| {
            std::env::var(name)
                .ok()
                .filter(|v| v.len() <= max)
                .ok_or(Error::Invalid)
        };
        let address = get("HAGENCY_RUNNER_API_ADDR", 128)?
            .parse()
            .map_err(|_| Error::Invalid)?;
        let capability = serde_json::from_str(&get("HAGENCY_RUNNER_CAPABILITY", 4096)?)
            .map_err(|_| Error::Invalid)?;
        Self::new(address, capability, get("HAGENCY_TASK_ID", 128)?)
    }
}

#[derive(clap::Subcommand)]
pub enum Command {
    /// Read the task assigned to this runner.
    Get,
    /// Record a heartbeat of the task already started by the host dispatch.
    Start,
    Heartbeat,
    Wait {
        #[arg(long)]
        reason: String,
        #[arg(long)]
        until: String,
    },
    Resume,
    Done,
    Comment {
        #[arg(long)]
        text: String,
    },
}
impl Command {
    fn operation(&self) -> Result<Option<TaskMutation>, Error> {
        Ok(Some(match self {
            Self::Get => return Ok(None),
            Self::Start | Self::Heartbeat => TaskMutation::Execution {
                heartbeat: true,
                waiting_reason: TextPatch::Missing,
                waiting_until: TextPatch::Missing,
            },
            Self::Wait { reason, until } => {
                text(reason, 1024).map_err(|_| Error::Invalid)?;
                text(until, 64).map_err(|_| Error::Invalid)?;
                TaskMutation::Transition {
                    status: TaskState::Blocked,
                    waiting_reason: Some(reason.clone()),
                    waiting_until: Some(until.clone()),
                }
            }
            Self::Resume | Self::Done => TaskMutation::Transition {
                status: if matches!(self, Self::Resume) {
                    TaskState::InProgress
                } else {
                    TaskState::Done
                },
                waiting_reason: None,
                waiting_until: None,
            },
            Self::Comment { text: body } => {
                text(body, 8192).map_err(|_| Error::Invalid)?;
                TaskMutation::Comment { text: body.clone() }
            }
        }))
    }
}

#[derive(Serialize)]
pub struct Output {
    pub task: Task,
    pub call_id: Option<String>,
    pub replayed: bool,
}

pub async fn run(
    context: &Context,
    command: &Command,
    call_id: Option<&str>,
    deadline: Duration,
) -> Result<Output, Error> {
    if deadline.is_zero() || deadline > Duration::from_secs(30) {
        return Err(Error::Invalid);
    }
    let operation = command.operation()?;
    let (path, body) = if let Some(operation) = &operation {
        let call = call_id.ok_or(Error::Invalid)?;
        identifier(call, 512).map_err(|_| Error::Invalid)?;
        (
            format!("/api/native/v1/runner/tasks/{}/operations", context.task_id),
            serde_json::to_vec(&json!({"call_id":call,"operation":operation}))
                .map_err(|_| Error::Invalid)?,
        )
    } else {
        if call_id.is_some() {
            return Err(Error::Invalid);
        }
        (
            format!("/api/native/v1/runner/tasks/{}", context.task_id),
            Vec::new(),
        )
    };
    if body.len() > REQUEST_LIMIT {
        return Err(Error::Invalid);
    }
    let mut submitted = false;
    let result = timeout(
        deadline,
        exchange(context, &path, body, operation.is_some(), &mut submitted),
    )
    .await;
    let bytes = match result {
        Ok(v) => v?,
        Err(_) => {
            return Err(if submitted && operation.is_some() {
                Error::Unknown
            } else {
                Error::Unavailable
            });
        }
    };
    let (task, replayed) = if operation.is_some() {
        let result: MutationResult = serde_json::from_slice(&bytes).map_err(|_| Error::Unknown)?;
        (result.task, result.replayed)
    } else {
        (
            serde_json::from_slice::<Task>(&bytes).map_err(|_| Error::Response)?,
            false,
        )
    };
    if task.id != context.task_id {
        return Err(if operation.is_some() {
            Error::Unknown
        } else {
            Error::Response
        });
    }
    Ok(Output {
        task,
        call_id: call_id.map(str::to_owned),
        replayed,
    })
}

async fn exchange(
    context: &Context,
    path: &str,
    body: Vec<u8>,
    mutation: bool,
    submitted: &mut bool,
) -> Result<Vec<u8>, Error> {
    let stream = TcpStream::connect(context.address)
        .await
        .map_err(|_| Error::Unavailable)?;
    let (mut sender, connection) = http1::Builder::new()
        .max_headers(32)
        .max_buf_size(16 * 1024)
        .handshake::<_, Full<Bytes>>(TokioIo::new(stream))
        .await
        .map_err(|_| Error::Unavailable)?;
    let mut authorization =
        hyper::header::HeaderValue::from_str(&format!("Bearer {}", context.capability.secret))
            .map_err(|_| Error::Invalid)?;
    authorization.set_sensitive(true);
    let request = Request::builder()
        .method(if mutation { "POST" } else { "GET" })
        .uri(path)
        .header("host", context.address.to_string())
        .header("authorization", authorization)
        .header("x-hagency-dispatch", &context.capability.dispatch_id)
        .header("x-hagency-runner", &context.capability.runner_id)
        .header("x-hagency-fence", context.capability.fence.to_string())
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .header("connection", "close")
        .body(Full::new(Bytes::from(body)))
        .map_err(|_| Error::Invalid)?;
    let failure = if mutation {
        Error::Unknown
    } else {
        Error::Response
    };
    *submitted = true;
    let response = async {
        let mut response = sender.send_request(request).await.map_err(|_| failure)?;
        let status = response.status();
        if !status.is_success() {
            // Never consume/log private error bodies, follow redirects or retry.
            return Err(if mutation && status.is_server_error() {
                Error::Unknown
            } else {
                Error::Refused(status.as_u16())
            });
        }
        if status.as_u16() != 200
            || response.headers().get_all("content-type").iter().count() != 1
            || response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_none_or(|s| {
                    s.split(';')
                        .next()
                        .is_none_or(|s| s.trim() != "application/json")
                })
            || response.headers().contains_key("content-encoding")
        {
            return Err(failure);
        }
        if let Some(length) = response.headers().get("content-length") {
            let length: usize = length
                .to_str()
                .ok()
                .and_then(|s| s.parse().ok())
                .ok_or(failure)?;
            if length > RESPONSE_LIMIT {
                return Err(failure);
            }
        }
        let mut bytes = Vec::new();
        while let Some(frame) = response.body_mut().frame().await {
            let frame = frame.map_err(|_| failure)?;
            let data = frame.into_data().map_err(|_| failure)?;
            if bytes
                .len()
                .checked_add(data.len())
                .is_none_or(|len| len > RESPONSE_LIMIT)
            {
                return Err(failure);
            }
            bytes.extend_from_slice(&data);
        }
        Ok(bytes)
    };
    tokio::pin!(response, connection);
    // Poll the connection in this operation, without detached tasks. Cancelling
    // the outer future drops the connection and closes its owned socket.
    tokio::select! {
        biased;
        result = &mut response => result,
        result = &mut connection => {
            result.map_err(|_|failure)?;
            response.await
        }
    }
}
