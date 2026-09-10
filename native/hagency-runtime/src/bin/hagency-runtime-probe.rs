//! Offline native fixture, never a model or a public runtime-launch endpoint.
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::{self, BufRead, Write},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn pulse(marker: &Path) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(marker.with_extension("pulse"))?;
    let until = Instant::now() + Duration::from_secs(8);
    while Instant::now() < until {
        file.write_all(b"x")?;
        file.flush()?;
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}
fn read(reader: &mut impl BufRead, marker: &Path) -> io::Result<Value> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        let count = available
            .iter()
            .position(|&c| c == b'\n')
            .map_or(available.len(), |n| n + 1);
        if bytes.len() + count > 1_048_577 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if bytes.last() == Some(&b'\n') {
            break;
        }
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(marker.with_extension("requests"))?
        .write_all(&bytes)?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}
fn send(value: Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    let mut stdout = io::stdout().lock();
    stdout.write_all(&bytes)?;
    stdout.flush()
}
fn result(request: &Value, value: Value) -> io::Result<()> {
    send(json!({ "id": request["id"], "result": value }))
}
fn note(method: &str, params: Value) -> io::Result<()> {
    send(json!({ "method": method, "params": params }))
}
fn method(request: &Value, expected: &str) -> io::Result<()> {
    if request["method"] == expected {
        Ok(())
    } else {
        Err(io::Error::other("unexpected fixture method"))
    }
}
fn fake(mode: &str, marker: &Path) -> io::Result<()> {
    fs::write(marker.with_extension("entered"), b"entered")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        let mut sockets = 0;
        for entry in fs::read_dir("/dev/fd")? {
            if fs::metadata(entry?.path()).is_ok_and(|v| v.file_type().is_socket()) {
                sockets += 1;
            }
        }
        fs::write(marker.with_extension("sockets"), sockets.to_string())?;
    }
    if mode == "keepalive" || mode == "silent" {
        return pulse(marker);
    }
    let mut child = if mode == "descendant" || mode == "detached" {
        let child_marker = marker.with_file_name(format!("{mode}-child"));
        let mut command = Command::new(std::env::current_exe()?);
        command
            .arg("pulse")
            .arg(&child_marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        if mode == "detached" {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn()?;
        // Observe a distinct child's output before protocol completion can cause
        // the owner to stop us. This prevents a never-scheduled child from being
        // mistaken for a successfully exercised descendant termination path.
        let until = Instant::now() + Duration::from_secs(3);
        while fs::metadata(child_marker.with_extension("pulse")).map_or(0, |m| m.len()) < 2 {
            if Instant::now() >= until {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::other("fixture descendant did not start"));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Some(child)
    } else {
        None
    };
    let mut stdin = io::stdin().lock();
    let request = read(&mut stdin, marker)?;
    method(&request, "initialize")?;
    if mode == "eof" {
        return Ok(());
    }
    if mode == "noisy" {
        io::stderr().write_all(&vec![b'e'; 256 * 1024])?;
        io::stderr().flush()?;
    }
    result(
        &request,
        json!({ "userAgent": "offline-fixture/0.153.4", "platformFamily": "unix", "platformOs": "fixture", "codexHome": "/fixture" }),
    )?;
    method(&read(&mut stdin, marker)?, "initialized")?;
    let request = read(&mut stdin, marker)?;
    method(&request, "thread/start")?;
    let params = &request["params"];
    if params["approvalPolicy"] != "on-request"
        || params["approvalsReviewer"] != "user"
        || params["sandbox"] != "workspace-write"
    {
        return Err(io::Error::other("fixture policy mismatch"));
    }
    result(
        &request,
        json!({ "thread": { "id": "owned-thread", "cwd": params["cwd"], "status": { "type": "idle" }, "turns": [] },
        "cwd": params["cwd"], "model": params["model"], "modelProvider": "offline", "approvalPolicy": "on-request", "approvalsReviewer": "user", "sandbox": { "type": "workspaceWrite" } }),
    )?;
    if mode == "blocked" {
        return pulse(marker);
    }
    let request = read(&mut stdin, marker)?;
    method(&request, "turn/start")?;
    if request["params"]["threadId"] != "owned-thread"
        || request["params"]["sandboxPolicy"]["networkAccess"] != false
    {
        return Err(io::Error::other("fixture turn mismatch"));
    }
    result(
        &request,
        json!({ "turn": { "id": "owned-turn", "status": "inProgress", "items": [] } }),
    )?;
    note(
        "item/started",
        json!({ "threadId": "owned-thread", "turnId": "owned-turn", "startedAtMs": 1, "item": { "id": "answer", "type": "agentMessage", "phase": "final_answer", "text": "" } }),
    )?;
    let answer = "离线管道验证完成";
    note(
        "item/agentMessage/delta",
        json!({ "threadId": "owned-thread", "turnId": "owned-turn", "itemId": "answer", "delta": answer }),
    )?;
    note(
        "item/completed",
        json!({ "threadId": "owned-thread", "turnId": "owned-turn", "completedAtMs": 2, "item": { "id": "answer", "type": "agentMessage", "phase": "final_answer", "text": answer } }),
    )?;
    note(
        "turn/completed",
        json!({ "threadId": "owned-thread", "turn": { "id": "owned-turn", "status": "completed", "items": [] } }),
    )?;
    // Stay alive after writing terminal output. The host must explicitly stop
    // ownership; the fixture does not convert protocol completion into exit.
    let outcome = pulse(marker);
    if let Some(child) = &mut child {
        let _ = child.kill();
        let _ = child.wait();
    }
    outcome
}
fn main() -> io::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    #[cfg(unix)]
    if args.first().is_some_and(|v| v == "guardian") {
        return hagency_platform::run_guardian();
    }
    match args.as_slice() {
        [mode, marker] if mode == "pulse" => pulse(Path::new(marker)),
        [command, mode, marker] if command == "fake-server" => fake(
            mode.to_str().ok_or(io::ErrorKind::InvalidInput)?,
            Path::new(marker),
        ),
        _ => Err(io::Error::other("offline fixture mode required")),
    }
}
