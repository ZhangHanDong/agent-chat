use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn launch(state: &Path, address: SocketAddr) -> Running {
    let child = Command::new(env!("CARGO_BIN_EXE_hagency"))
        .args(["serve", "--state-dir"])
        .arg(state)
        .args(["--listen", &address.to_string()])
        .env("PATH", "")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut running = Running(child);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = running.0.try_wait().unwrap() {
            let mut error = String::new();
            if let Some(mut stderr) = running.0.stderr.take() {
                stderr.read_to_string(&mut error).unwrap();
            }
            panic!("native service exited before health ({status}): {error}");
        }
        if let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(100)) {
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            write!(
                stream,
                "GET /health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            if response.starts_with("HTTP/1.1 200") {
                return running;
            }
        }
        assert!(
            Instant::now() < deadline,
            "native service startup timed out"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn submit(address: SocketAddr, token: &str) -> String {
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let body = r#"{"binding":"fixture","generation":1,"id":"restart_request","lane":"work","kind":"request","payload":{"name":"小白"}}"#;
    write!(stream, "POST /api/native/v1/custody HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(
        response.starts_with("HTTP/1.1 202"),
        "custody was not accepted"
    );
    let body = response.split("\r\n\r\n").nth(1).unwrap();
    serde_json::from_str::<serde_json::Value>(body).expect("native JSON response");
    body.to_owned()
}
#[test]
fn native_binary_survives_crash_without_node() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("中文 state");
    let init = Command::new(env!("CARGO_BIN_EXE_hagency"))
        .args(["init", "--state-dir"])
        .arg(&state)
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(
        init.status.success(),
        "init failed: {}",
        String::from_utf8_lossy(&init.stderr)
    );
    let token = fs::read_to_string(state.join("operator.token")).unwrap();
    assert!(!String::from_utf8_lossy(&init.stdout).contains(&token));
    let before = fs::read(state.join("operator.token")).unwrap();
    assert!(
        !Command::new(env!("CARGO_BIN_EXE_hagency"))
            .args(["init", "--state-dir"])
            .arg(&state)
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(fs::read(state.join("operator.token")).unwrap(), before);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let running = launch(&state, address);
    let receipt = submit(address, &token);
    drop(running); // Unclean process loss, not an in-memory reopen.
    let _restarted = launch(&state, address);
    assert_eq!(submit(address, &token), receipt);
}
