//! Fixed host task-maintenance helper. No capability value, generic config map,
//! Deserialize, Debug, or runtime-authority constructor exists here.
use super::{Error, Settings};
use serde_json::{Value, json};
use std::path::{Component, PathBuf};

pub const TASK_MCP_ENV: [&str; 3] = [
    "HAGENCY_RUNNER_API_ADDR",
    "HAGENCY_RUNNER_CAPABILITY",
    "HAGENCY_TASK_ID",
];
pub const TASK_MCP_TOOLS: [&str; 3] = ["get_task", "update_task_execution", "transition_task"];
pub struct TaskMcp {
    executable: String,
    task_id: String,
    system_root: Option<String>,
}
impl TaskMcp {
    pub fn new(
        executable: PathBuf,
        task_id: String,
        system_root: Option<String>,
    ) -> Result<Self, Error> {
        if !executable.is_absolute()
            || executable
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
            || task_id.is_empty()
            || task_id.len() > 128
            || !task_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
        {
            return Err(Error::Settings);
        }
        let executable = executable
            .to_str()
            .filter(|v| super::super::text(v, 4096))
            .ok_or(Error::Settings)?
            .to_owned();
        if let Some(root) = &system_root
            && (!PathBuf::from(root).is_absolute() || !super::super::text(root, 4096))
        {
            return Err(Error::Settings);
        }
        Ok(Self {
            executable,
            task_id,
            system_root,
        })
    }
    pub(super) fn config(&self, cwd: &str) -> Value {
        let mut config = json!({
            "mcp_servers.hagency_task_writer": {
                "command":self.executable,"args":["mcp"],"cwd":cwd,
                "env_vars":TASK_MCP_ENV,"enabled":true,"required":true,
                "startup_timeout_sec":5,"tool_timeout_sec":5,
                "supports_parallel_tool_calls":false,"enabled_tools":TASK_MCP_TOOLS
            },
            "shell_environment_policy.inherit":"none",
            "shell_environment_policy.ignore_default_excludes":false,
            "shell_environment_policy.experimental_use_profile":false
        });
        if let Some(root) = &self.system_root {
            config["shell_environment_policy.set.SystemRoot"] = root.clone().into();
        }
        config
    }
    pub(super) fn guidance(&self) -> String {
        format!(
            "The assigned canonical task ID is {}. Use the hagency_task_writer MCP tools for this exact task. Tool results determine canonical state; a final answer does not complete the task.",
            self.task_id
        )
    }
}
impl Settings {
    pub fn with_task_mcp(mut self, helper: TaskMcp) -> Self {
        self.task_mcp = Some(helper);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_task_mcp_host_configuration() {
        let root = std::env::temp_dir();
        let settings = Settings::new(root.clone(), "offline".into(), "medium".into())
            .unwrap()
            .with_task_mcp(
                TaskMcp::new(root.join("native-helper"), "task_assigned".into(), None).unwrap(),
            );
        let params = settings.thread_request(None);
        let config = &params["config"];
        let helper = &config["mcp_servers.hagency_task_writer"];
        assert_eq!(helper["args"], json!(["mcp"]));
        assert_eq!(helper["env_vars"], json!(TASK_MCP_ENV));
        assert!(helper.get("env").is_none());
        assert!(helper.get("url").is_none());
        assert!(helper.get("default_tools_approval_mode").is_none());
        assert_eq!(helper["enabled_tools"], json!(TASK_MCP_TOOLS));
        assert_eq!(config["shell_environment_policy.inherit"], "none");
        assert_eq!(params["approvalPolicy"], "on-request");
        assert_eq!(params["sandbox"], "workspace-write");
        assert!(
            params["developerInstructions"]
                .as_str()
                .unwrap()
                .contains("task_assigned")
        );
        assert_eq!(
            settings.turn_request("thread", "input".into())["sandboxPolicy"]["networkAccess"],
            false
        );
        assert!(TaskMcp::new("relative".into(), "task".into(), None).is_err());
        assert!(TaskMcp::new(root.join("helper"), "task\nignore".into(), None).is_err());
        assert!(TaskMcp::new(root.join("helper"), "task".into(), Some("relative".into())).is_err());
    }
}
