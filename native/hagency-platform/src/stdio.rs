//! One-use IO ownership; these endpoints carry data, never process authority.
#[cfg(unix)]
use std::{io, os::fd::OwnedFd};

pub struct StdioPipes {
    #[cfg(unix)]
    stdin: OwnedFd,
    #[cfg(unix)]
    stdout: OwnedFd,
    #[cfg(unix)]
    stderr: OwnedFd,
    #[cfg(windows)]
    _unavailable: (),
}
#[cfg(unix)]
pub(crate) struct ChildPipes {
    pub stdin: OwnedFd,
    pub stdout: OwnedFd,
    pub stderr: OwnedFd,
}
#[cfg(unix)]
impl StdioPipes {
    pub(crate) fn pair() -> io::Result<(Self, ChildPipes)> {
        let (child_stdin, stdin) = pipe()?;
        let (stdout, child_stdout) = pipe()?;
        let (stderr, child_stderr) = pipe()?;
        Ok((
            Self {
                stdin,
                stdout,
                stderr,
            },
            ChildPipes {
                stdin: child_stdin,
                stdout: child_stdout,
                stderr: child_stderr,
            },
        ))
    }
    /// Consume exactly once. Closing data pipes is not proof of child cleanup.
    pub fn into_parts(self) -> (OwnedFd, OwnedFd, OwnedFd) {
        (self.stdin, self.stdout, self.stderr)
    }
}
#[cfg(unix)]
pub(crate) fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    #[cfg(target_os = "linux")]
    {
        Ok(rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)?)
    }
    #[cfg(target_os = "macos")]
    {
        let pair = rustix::pipe::pipe()?;
        for fd in [&pair.0, &pair.1] {
            rustix::io::fcntl_setfd(fd, rustix::io::FdFlags::CLOEXEC)?;
        }
        // macOS lacks pipe2. Complete sealing before our spawn; every owned
        // launch also seals its complete post-fork descriptor table.
        Ok(pair)
    }
}
