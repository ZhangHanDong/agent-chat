//! Single-owner, length-prefixed socket IO with bounded partial-frame lifetime.
use serde::{Serialize, de::DeserializeOwned};
use std::{
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

pub(super) const FRAME_LIMIT: usize = 512 * 1024;
pub(super) struct Pipe {
    pub(super) stream: UnixStream,
    header: [u8; 4],
    header_read: usize,
    body: Vec<u8>,
    body_read: usize,
    started: Option<Instant>,
}
impl Pipe {
    pub(super) fn new(stream: UnixStream) -> Self {
        Self {
            stream,
            header: [0; 4],
            header_read: 0,
            body: Vec::new(),
            body_read: 0,
            started: None,
        }
    }
    pub(super) fn send<T: Serialize>(&mut self, value: &T, until: Instant) -> io::Result<()> {
        let bytes = serde_json::to_vec(value).map_err(|_| invalid())?;
        if bytes.is_empty() || bytes.len() > FRAME_LIMIT {
            return Err(invalid());
        }
        let header = (bytes.len() as u32).to_be_bytes();
        for mut remaining in [header.as_slice(), bytes.as_slice()] {
            while !remaining.is_empty() {
                let timeout = until
                    .checked_duration_since(Instant::now())
                    .filter(|v| !v.is_zero())
                    .ok_or_else(timed_out)?;
                self.stream.set_write_timeout(Some(timeout))?;
                match self.stream.write(remaining) {
                    Ok(0) => {
                        return Err(io::Error::new(
                            io::ErrorKind::WriteZero,
                            "guardian channel closed",
                        ));
                    }
                    Ok(count) => remaining = &remaining[count..],
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(())
    }
    /// A tick can expire without discarding partial bytes. A peer cannot keep a
    /// frame alive indefinitely by dribbling bytes; its absolute age is bounded.
    pub(super) fn receive<T: DeserializeOwned>(
        &mut self,
        until: Instant,
        limit: usize,
    ) -> io::Result<Option<T>> {
        loop {
            let now = Instant::now();
            if self
                .started
                .is_some_and(|start| now.duration_since(start) >= Duration::from_secs(1))
            {
                return Err(invalid());
            }
            let Some(timeout) = until.checked_duration_since(now).filter(|v| !v.is_zero()) else {
                return Ok(None);
            };
            self.stream
                .set_read_timeout(Some(timeout.min(Duration::from_millis(25))))?;
            let buffer = if self.header_read < 4 {
                &mut self.header[self.header_read..]
            } else {
                &mut self.body[self.body_read..]
            };
            match self.stream.read(buffer) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "guardian owner channel closed",
                    ));
                }
                Ok(count) => {
                    self.started.get_or_insert_with(Instant::now);
                    if self.header_read < 4 {
                        self.header_read += count;
                        if self.header_read == 4 {
                            let length = u32::from_be_bytes(self.header) as usize;
                            if length == 0 || length > limit.min(FRAME_LIMIT) {
                                return Err(invalid());
                            }
                            self.body.resize(length, 0);
                        }
                    } else {
                        self.body_read += count;
                        if self.body_read == self.body.len() {
                            let value =
                                serde_json::from_slice(&self.body).map_err(|_| invalid())?;
                            self.header_read = 0;
                            self.body_read = 0;
                            self.body.clear();
                            self.started = None;
                            return Ok(Some(value));
                        }
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::Interrupted
                            | io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
    }
    pub(super) fn required<T: DeserializeOwned>(
        &mut self,
        until: Instant,
        limit: usize,
    ) -> io::Result<T> {
        self.receive(until, limit)?.ok_or_else(timed_out)
    }
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid guardian frame")
}
fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "guardian channel timed out")
}
