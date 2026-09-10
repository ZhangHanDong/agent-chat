use crate::{Launch, StopReport};
use rustix::process::{Pid, Signal, kill_process_group};
use std::{
    io,
    os::unix::process::CommandExt,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

pub(super) struct Process {
    child: Option<Child>,
    pid: Pid,
    signalled: bool,
}
impl Process {
    pub(super) fn spawn(launch: &Launch) -> io::Result<Self> {
        if launch.require_crash_containment {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "POSIX guardian crash containment is not implemented",
            ));
        }
        let mut child = Command::new(&launch.executable)
            .args(&launch.arguments)
            .current_dir(&launch.directory)
            .env_clear()
            .envs(&launch.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()?;
        // Never permit kill(-1) semantics, even if an exotic namespace starts
        // with an unexpected PID. Only this unreaped child establishes authority.
        let Some(pid) = i32::try_from(child.id())
            .ok()
            .filter(|pid| *pid > 1)
            .and_then(Pid::from_raw)
        else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("invalid process scope leader"));
        };
        Ok(Self {
            child: Some(child),
            pid,
            signalled: false,
        })
    }
    pub(super) fn id(&self) -> u32 {
        self.pid.as_raw_pid() as u32
    }
    pub(super) fn stop(&mut self, timeout: Duration) -> io::Result<StopReport> {
        let Some(child) = self.child.as_mut() else {
            return Ok(StopReport {
                leader_exited: true,
                whole_tree_stopped: false,
            });
        };
        // Do not try_wait or reap before the final signal: the leader's retained
        // PID prevents an unrelated process from creating a reused group ID.
        if !self.signalled {
            match kill_process_group(self.pid, Signal::KILL) {
                Ok(()) | Err(rustix::io::Errno::SRCH) => {}
                Err(error) => return Err(error.into()),
            }
            // The child may have moved out of its original group. Its unreaped
            // Child still owns the individual PID; this is not a census PID kill.
            if let Err(error) = child.kill()
                && error.raw_os_error() != Some(rustix::io::Errno::SRCH.raw_os_error())
            {
                return Err(error);
            }
            self.signalled = true;
        }
        let until = Instant::now() + timeout;
        loop {
            if child.try_wait()?.is_some() {
                self.child = None;
                return Ok(StopReport {
                    leader_exited: true,
                    whole_tree_stopped: false,
                });
            }
            if Instant::now() >= until {
                return Ok(StopReport {
                    leader_exited: false,
                    whole_tree_stopped: false,
                });
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
