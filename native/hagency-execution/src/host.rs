use hagency_core::tasks::RunnerCapability;
use hagency_platform::Launch;
use hagency_runtime::codex::{
    session::{Settings, TASK_MCP_ENV, TaskMcp},
    transport,
};
use hagency_store::OwnedDispatchScope;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    net::SocketAddr,
    path::{Path, PathBuf},
};

/// One operation uses a 100 ms..30 s absolute monotonic execution deadline.
/// Native response/write waits are 10 ms..2 s. Cancellation is checked every
/// 20 ms; authority is scheduled every 100 ms and its receipt may take up to 2 s.
/// Synchronous join has a conservative 60 s maximum combined wait allowance
/// (30 s execution plus platform startup/stop/drop and final domain receipts).
/// This bounds library waits, not OS scheduling or a stalled kernel syscall.
#[derive(Clone, Copy)]
pub struct Limits {
    pub operation_ms: u64,
    pub response_ms: u64,
}
impl Limits {
    pub(crate) fn validate(self) -> bool {
        (100..=30_000).contains(&self.operation_ms)
            && (10..=2_000).contains(&self.response_ms)
            && self.response_ms <= self.operation_ms
    }
}

/// Host configuration only: no Deserialize and no runtime/HTTP constructor.
/// The caller must exclusively provision fixed workspace directories and their
/// ancestors for the entire operation. Equality/canonicalize is NOT race-proof
/// directory custody, and this API must not enable a production runner catalog.
pub struct Host {
    pub(crate) guardian: PathBuf,
    executable: PathBuf,
    environment: BTreeMap<OsString, OsString>,
    workspaces: BTreeMap<String, PathBuf>,
    task_helper: Option<(PathBuf, SocketAddr)>,
    #[cfg(test)]
    pub(crate) discard_start_reply: bool,
    #[cfg(test)]
    pub(crate) discard_usage_binding_reply: bool,
}
impl Host {
    pub fn new(
        guardian: PathBuf,
        executable: PathBuf,
        environment: BTreeMap<OsString, OsString>,
        workspaces: BTreeMap<String, PathBuf>,
    ) -> Result<Self, super::Failure> {
        if !guardian.is_absolute()
            || !executable.is_absolute()
            || workspaces.is_empty()
            || workspaces.len() > 16
        {
            return Err(super::Failure::Admission);
        }
        for (id, path) in &workspaces {
            hagency_core::project::identifier(id, 128).map_err(|_| super::Failure::Admission)?;
            if !path.is_absolute()
                || !path.is_dir()
                || path.canonicalize().ok().as_ref() != Some(path)
            {
                return Err(super::Failure::Admission);
            }
        }
        // Reuse the launch validator for exact environment/argv byte limits.
        Launch {
            executable: executable.clone(),
            arguments: vec!["app-server".into()],
            directory: workspaces
                .values()
                .next()
                .ok_or(super::Failure::Admission)?
                .clone(),
            environment: environment.clone(),
            require_crash_containment: false,
        }
        .validate()
        .map_err(|_| super::Failure::Admission)?;
        Ok(Self {
            guardian,
            executable,
            environment,
            workspaces,
            task_helper: None,
            #[cfg(test)]
            discard_start_reply: false,
            #[cfg(test)]
            discard_usage_binding_reply: false,
        })
    }
    /// Host-selected native executable and literal loopback endpoint only. The
    /// task/capability are supplied later from the validated owned dispatch.
    /// The host must protect the executable, workspace and Codex config/home;
    /// these path checks are not physical directory or executable custody.
    pub fn with_task_helper(
        mut self,
        executable: PathBuf,
        address: SocketAddr,
    ) -> Result<Self, super::Failure> {
        if !address.ip().is_loopback()
            || address.port() == 0
            || matches!(address, SocketAddr::V6(v) if v.scope_id()!=0 || v.flowinfo()!=0)
            || !executable.is_file()
            || self.environment.keys().any(|key| {
                TASK_MCP_ENV
                    .iter()
                    .any(|reserved| key.to_string_lossy().eq_ignore_ascii_case(reserved))
            })
        {
            return Err(super::Failure::Admission);
        }
        TaskMcp::new(
            executable.clone(),
            "validation_only".into(),
            self.system_root()?,
        )
        .map_err(|_| super::Failure::Admission)?;
        self.task_helper = Some((executable, address));
        Ok(self)
    }
    fn system_root(&self) -> Result<Option<String>, super::Failure> {
        let mut roots = self
            .environment
            .iter()
            .filter(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case("SystemRoot"));
        let first = roots
            .next()
            .map(|(_, v)| {
                v.to_str()
                    .map(str::to_owned)
                    .ok_or(super::Failure::Admission)
            })
            .transpose()?;
        if roots.next().is_some() {
            return Err(super::Failure::Admission);
        }
        Ok(first)
    }
    pub(crate) fn task_helper_enabled(&self) -> bool {
        self.task_helper.is_some()
    }
    pub(crate) fn prepare(
        &self,
        scope: &OwnedDispatchScope,
        capability: &RunnerCapability,
        limits: Limits,
    ) -> Result<(Launch, Settings, transport::Limits, String), super::Failure> {
        let [workspace] = scope.input().resources.as_slice() else {
            return Err(super::Failure::Admission);
        };
        if !workspace.exclusive || !limits.validate() {
            return Err(super::Failure::Admission);
        }
        let path = self
            .workspaces
            .get(&workspace.id)
            .ok_or(super::Failure::Admission)?;
        let resource = scope.resource();
        if resource.framework != "codex"
            || resource.provider.as_deref().is_some_and(|v| v != "openai")
        {
            return Err(super::Failure::Admission);
        }
        let effort = resource.reasoning.as_deref().unwrap_or("medium");
        if !["none", "minimal", "low", "medium", "high", "xhigh"].contains(&effort) {
            return Err(super::Failure::Admission);
        }
        if Path::new(path).canonicalize().ok().as_ref() != Some(path) {
            return Err(super::Failure::Admission);
        }
        let mut settings = Settings::new(path.clone(), resource.model.clone(), effort.into())
            .map_err(|_| super::Failure::Admission)?;
        // Every byte comes from the immutable dispatch payload. This informational
        // text grants neither task maintenance, process authority nor approval.
        let input = hagency_core::canonical::encode_payload(&scope.input().payload)
            .map_err(|_| super::Failure::Admission)?;
        if input.len() > hagency_runtime::codex::session::MAX_TEXT_BYTES {
            return Err(super::Failure::Admission);
        }
        let mut environment = self.environment.clone();
        if let Some((executable, address)) = &self.task_helper {
            let helper = TaskMcp::new(
                executable.clone(),
                scope.task().id.clone(),
                self.system_root()?,
            )
            .map_err(|_| super::Failure::Admission)?;
            let encoded =
                serde_json::to_string(capability).map_err(|_| super::Failure::Admission)?;
            if encoded.len() > 4096 {
                return Err(super::Failure::Admission);
            }
            environment.insert(TASK_MCP_ENV[0].into(), address.to_string().into());
            environment.insert(TASK_MCP_ENV[1].into(), encoded.into());
            environment.insert(TASK_MCP_ENV[2].into(), scope.task().id.clone().into());
            settings = settings.with_task_mcp(helper);
        }
        let launch = Launch {
            executable: self.executable.clone(),
            arguments: vec!["app-server".into()],
            directory: path.clone(),
            environment,
            require_crash_containment: false,
        };
        launch.validate().map_err(|_| super::Failure::Admission)?;
        Ok((
            launch,
            settings,
            transport::Limits {
                write_timeout_ms: limits.response_ms,
                event_wait_ms: limits.response_ms,
                lifetime_ms: limits.operation_ms,
            },
            input,
        ))
    }
}
