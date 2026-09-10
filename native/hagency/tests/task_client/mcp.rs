use super::*;
use hagency::mcp::Session;
use rmcp::{ServiceExt, model::CallToolRequestParams};
use serde_json::Value;

async fn handle(s: &mut Session, v: Value) -> Option<Value> {
    s.handle(&serde_json::to_vec(&v).unwrap()).await.unwrap()
}
async fn initialized(s: &mut Session) {
    let v = handle(s, json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}})).await.unwrap();
    assert_eq!(v["result"]["capabilities"], json!({"tools":{}}));
    assert!(
        handle(
            s,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .await
        .is_none()
    );
}
async fn call(s: &mut Session, id: u64, name: &str, args: Value) -> Value {
    handle(s,json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":args}})).await.unwrap()["result"].clone()
}
#[tokio::test]
async fn native_mcp_task_lifecycle() {
    let f = Fixture::new(false).await;
    let mut s = Session::new(f.context());
    initialized(&mut s).await;
    let read = call(&mut s, 1, "get_task", json!({"id":"task"})).await;
    assert_eq!(read["structuredContent"]["task"]["status"], "in_progress");
    let heartbeat = call(
        &mut s,
        2,
        "update_task_execution",
        json!({"id":"task","call_id":"beat","heartbeat":true}),
    )
    .await;
    assert_eq!(heartbeat["isError"], false);
    let retry = call(
        &mut s,
        3,
        "update_task_execution",
        json!({"id":"task","call_id":"beat","heartbeat":true}),
    )
    .await;
    assert_eq!(retry["structuredContent"]["replayed"], true);
    assert_eq!(
        retry["structuredContent"]["task"],
        heartbeat["structuredContent"]["task"]
    );
    let mut reconnected = Session::new(f.context());
    initialized(&mut reconnected).await;
    let replay = call(
        &mut reconnected,
        1,
        "update_task_execution",
        json!({"id":"task","call_id":"beat","heartbeat":true}),
    )
    .await;
    assert_eq!(replay["structuredContent"]["replayed"], true);
    assert_eq!(
        replay["structuredContent"]["task"],
        heartbeat["structuredContent"]["task"]
    );
    assert_eq!(
        call(
            &mut reconnected,
            2,
            "comment_task",
            json!({"id":"task","call_id":"beat","text":"changed after reconnect"})
        )
        .await["isError"],
        true
    );
    for (id, name, args) in [
        (
            4,
            "comment_task",
            json!({"id":"task","call_id":"beat","text":"conflicts"}),
        ),
        (
            5,
            "comment_task",
            json!({"id":"other","call_id":"cross","text":"wrong task"}),
        ),
        (6, "comment_task", json!({"id":"task","text":"no call id"})),
        (
            7,
            "comment_task",
            json!({"id":"task","call_id":"inject","text":"body","action":"accept"}),
        ),
        (
            8,
            "get_task",
            json!({"id":"task","capability":{"secret":"untrusted"}}),
        ),
    ] {
        assert_eq!(call(&mut s, id, name, args).await["isError"], true);
    }
    let blocked = call(&mut s,9,"transition_task",json!({"id":"task","call_id":"wait","status":"blocked","waiting_reason":"review","waiting_until":"2030-01-01T00:00:00Z"})).await;
    assert_eq!(blocked["structuredContent"]["task"]["status"], "blocked");
    assert_eq!(
        call(
            &mut s,
            10,
            "transition_task",
            json!({"id":"task","call_id":"resume","status":"in_progress"})
        )
        .await["isError"],
        false
    );
    assert_eq!(
        call(
            &mut s,
            11,
            "comment_task",
            json!({"id":"task","call_id":"comment","text":"检查通过"})
        )
        .await["isError"],
        false
    );
    let done = call(
        &mut s,
        12,
        "transition_task",
        json!({"id":"task","call_id":"done","status":"done"}),
    )
    .await;
    assert_eq!(done["structuredContent"]["task"]["status"], "done");
    let replay = call(
        &mut s,
        13,
        "transition_task",
        json!({"id":"task","call_id":"done","status":"done"}),
    )
    .await;
    assert_eq!(replay["structuredContent"]["replayed"], true);
    assert_eq!(
        call(
            &mut s,
            14,
            "update_task_execution",
            json!({"id":"task","call_id":"after","heartbeat":true})
        )
        .await["isError"],
        true
    );
    let result = f
        .domain
        .runner_command(f.cap.clone(), RunnerCommand::Task { id: "task".into() })
        .await
        .unwrap();
    assert_eq!(result["status"], "done");
    f.close().await;

    for parked in [false, true] {
        let f = Fixture::new(parked).await;
        let mut cap = f.cap.clone();
        if !parked {
            cap.secret = "f".repeat(64);
        }
        let mut s = Session::new(Context::new(f.address, cap, "task".into()).unwrap());
        initialized(&mut s).await;
        let result = call(
            &mut s,
            1,
            "update_task_execution",
            json!({"id":"task","call_id":"refused","heartbeat":true}),
        )
        .await;
        assert_eq!(result["isError"], true);
        assert!(!result.to_string().contains(&f.cap.secret));
        f.close().await;
    }
}

#[tokio::test]
async fn native_mcp_sdk() {
    let f = Fixture::new(false).await;
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_hagency"));
    command
        .arg("mcp")
        .env_clear()
        .env("HAGENCY_RUNNER_API_ADDR", f.address.to_string())
        .env(
            "HAGENCY_RUNNER_CAPABILITY",
            serde_json::to_string(&f.cap).unwrap(),
        )
        .env("HAGENCY_TASK_ID", "task")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    let mut child = command.spawn().unwrap();
    let transport = (child.stdout.take().unwrap(), child.stdin.take().unwrap());
    tokio::time::timeout(Duration::from_secs(15), async {
        let client = ().serve(transport).await.unwrap();
        let tools = client.list_all_tools().await.unwrap();
        assert_eq!(tools.len(), 20);
        assert!(tools.iter().all(|v| !v.name.contains("approve")));
        let read = client
            .call_tool(
                CallToolRequestParams::new("get_task")
                    .with_arguments(json!({"id":"task"}).as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        assert_eq!(read.is_error, Some(false));
        assert_eq!(read.structured_content.unwrap()["task"]["id"], "task");
        let beat = client
            .call_tool(
                CallToolRequestParams::new("update_task_execution").with_arguments(
                    json!({"id":"task","call_id":"sdk","heartbeat":true})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        assert_eq!(beat.is_error, Some(false));
        client.cancel().await.unwrap();
    })
    .await
    .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "native helper failed: {:?}",
        output.stderr
    );
    assert!(output.stderr.is_empty());
    f.close().await;
}
