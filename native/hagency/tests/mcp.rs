use hagency::{
    mcp::{FRAME_LIMIT, Session},
    task_client::Context,
};
use hagency_core::tasks::RunnerCapability;
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};
fn capability() -> RunnerCapability {
    RunnerCapability {
        dispatch_id: "dispatch".into(),
        runner_id: "runner".into(),
        fence: 1,
        secret: "a".repeat(64),
    }
}
fn session() -> Session {
    Session::new(Context::new("127.0.0.1:9".parse().unwrap(), capability(), "task".into()).unwrap())
}
fn init(id: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}})
}
async fn request(s: &mut Session, v: Value) -> Option<Value> {
    s.handle(&serde_json::to_vec(&v).unwrap()).await.unwrap()
}
#[tokio::test]
async fn native_mcp_protocol() {
    let mut s = session();
    let before = request(
        &mut s,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
    )
    .await
    .unwrap();
    assert_eq!(before["error"]["code"], -32601);
    request(&mut s, init(json!("1"))).await.unwrap(); // Numeric and string IDs differ.
    assert!(
        request(
            &mut s,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .await
        .is_none()
    );
    let catalog = request(
        &mut s,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    )
    .await
    .unwrap();
    assert_eq!(catalog["result"]["tools"].as_array().unwrap().len(), 5);
    for tool in catalog["result"]["tools"].as_array().unwrap() {
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        assert!(!tool.to_string().contains("secret"));
    }
    for (id, params) in [
        (3, json!({"name":"missing","arguments":{"id":"task"}})),
        (4, json!({"name":"get_task","arguments":[]})),
        (5, json!({"arguments":{"id":"task"}})),
        (
            6,
            json!({"name":"get_task","arguments":{"id":"task"},"task":{}}),
        ),
    ] {
        let response = request(
            &mut s,
            json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":params}),
        )
        .await
        .unwrap();
        assert_eq!(response["error"]["code"], -32602);
        assert!(response.get("result").is_none());
    }
    assert_eq!(
        request(&mut s, json!({"jsonrpc":"2.0","id":7,"method":"ping"}))
            .await
            .unwrap()["result"],
        json!({})
    );
    assert!(
        s.handle(br#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#)
            .await
            .is_err()
    );
    assert!(
        s.handle(br#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#)
            .await
            .is_err()
    );
    for input in [
        br#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#.to_vec(),
        br#"{"jsonrpc":"2.0","id":1.5,"method":"ping"}"#.to_vec(),
        br#"{"jsonrpc":"2.0","id":9007199254740992,"method":"ping"}"#.to_vec(),
        br#"{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}"#.to_vec(),
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"arguments":{"id":"task","id":"other"}}}"#.to_vec(),
        br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_vec(),
        b"[]".to_vec(), b"{}{}".to_vec(), vec![b' ';FRAME_LIMIT+1],
        format!("{}0{}","[".repeat(80),"]".repeat(80)).into_bytes(),
    ] { assert!(session().handle(&input).await.is_err()); }
    let mut s = session();
    for n in 0..4096 {
        request(&mut s, json!({"jsonrpc":"2.0","id":n,"method":"ping"}))
            .await
            .unwrap();
    }
    assert!(
        s.handle(br#"{"jsonrpc":"2.0","id":4096,"method":"ping"}"#)
            .await
            .is_err()
    );
}
fn command() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_hagency"));
    cmd.arg("mcp")
        .env_clear()
        .env("HAGENCY_RUNNER_API_ADDR", "127.0.0.1:9")
        .env(
            "HAGENCY_RUNNER_CAPABILITY",
            serde_json::to_string(&capability()).unwrap(),
        )
        .env("HAGENCY_TASK_ID", "task")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        cmd.env("SystemRoot", root);
    }
    cmd
}
#[tokio::test]
async fn native_mcp_stdio() {
    let mut missing = command();
    missing
        .env_remove("HAGENCY_RUNNER_CAPABILITY")
        .env("API_TOKEN", "operator_must_not_work");
    let output = missing.output().await.unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("operator_must_not_work"));
    let mut child = command().spawn().unwrap();
    drop(child.stdin.take());
    assert!(
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    let mut child = command().spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(b"{").await.unwrap();
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.code(), Some(74));
    drop(input);
    let mut child = command().spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    // Consumer retains but never drains stdout; helper must terminate its own
    // blocked write. Keep sender joined and its buffer finite as well.
    let mut payload = serde_json::to_vec(&init(json!(0))).unwrap();
    payload.push(b'\n');
    payload.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n");
    for n in 1..1000 {
        payload.extend_from_slice(
            format!("{{\"jsonrpc\":\"2.0\",\"id\":{n},\"method\":\"tools/list\"}}\n").as_bytes(),
        );
    }
    let sender = tokio::spawn(async move {
        let _ = input.write_all(&payload).await;
    });
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.code(), Some(74));
    sender.await.unwrap();
}
