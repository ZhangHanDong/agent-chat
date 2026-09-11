use super::fixture::*;
use salvo::prelude::*;
use serde_json::json;
use std::{
    net::{SocketAddr, TcpListener as StdListener},
    path::PathBuf,
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

fn built() -> PathBuf {
    std::env::var_os("HAGENCY_NATIVE_CONSOLE_ASSETS").map(PathBuf::from).expect("native console qualification requires HAGENCY_NATIVE_CONSOLE_ASSETS from build:native; not a skipped test")
}
fn address() -> SocketAddr {
    StdListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
}
fn node() -> PathBuf {
    std::env::var_os("HAGENCY_BROWSER_NODE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"))
}
fn script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../mockup/scripts/native-console-browser.mjs")
}

#[tokio::test]
async fn native_console_browser() {
    let address = address();
    let f = Fixture::new(address, Some(&built()));
    hagency_store::private::write_new(
        &f.root.path().join("state/operator.token"),
        TOKEN.as_bytes(),
    )
    .unwrap();
    let acceptor = TcpListener::new(address).try_bind().await.unwrap();
    let server = Server::new(acceptor);
    let handle = server.handle();
    let serving = tokio::spawn(server.try_serve(f.app.clone().router()));
    let url = hagency::console::client::access(&f.root.path().join("state"), address)
        .await
        .unwrap();
    let mut child = Command::new(node())
        .arg(script())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .expect("actual browser tooling must exist");
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(
            format!(
                "{}\n",
                json!({"base":format!("http://{address}"),"url":url,"engagement":f.engagement})
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut created = false;
    tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if line == "CREATE_ENGAGEMENT" {
                assert!(!created);
                let id = f.new_engagement().await;
                input
                    .write_all(format!("{}\n", json!({"engagement":id})).as_bytes())
                    .await
                    .unwrap();
                created = true;
            } else {
                println!("{line}");
            }
        }
        assert!(
            child.wait().await.unwrap().success(),
            "real browser assertions failed"
        );
    })
    .await
    .expect("real browser deadline");
    assert!(
        created,
        "browser must discover an engagement created while it is running"
    );
    handle.stop_graceful(Some(Duration::from_secs(2)));
    serving.await.unwrap().unwrap();
    f.close().await;
}

#[tokio::test]
async fn native_console_executable() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    let empty_path = root.path().join("empty-path");
    std::fs::create_dir(&empty_path).unwrap();
    let binary = env!("CARGO_BIN_EXE_hagency");
    let init = Command::new(binary)
        .args(["init", "--state-dir"])
        .arg(&state)
        .env_clear()
        .env("PATH", &empty_path)
        .output()
        .await
        .unwrap();
    assert!(
        init.status.success(),
        "{}",
        String::from_utf8_lossy(&init.stderr)
    );
    let (db, engagement) = seed(&state);
    drop(db);
    let address = address();
    let mut server = Command::new(binary)
        .args(["serve", "--state-dir"])
        .arg(&state)
        .args(["--listen", &address.to_string(), "--console-assets"])
        .arg(built())
        .env_clear()
        .env("PATH", &empty_path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if tokio::net::TcpStream::connect(address).await.is_ok() {
                break;
            }
            assert!(
                server.try_wait().unwrap().is_none(),
                "native console process exited before admission"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("native executable startup");
    let link = Command::new(binary)
        .args(["console-access", "--state-dir"])
        .arg(&state)
        .args(["--listen", &address.to_string()])
        .env_clear()
        .env("PATH", &empty_path)
        .output()
        .await
        .unwrap();
    assert!(
        link.status.success(),
        "native access command must work without Node on PATH"
    );
    let url = String::from_utf8(link.stdout).unwrap().trim().to_owned();
    assert!(!url.contains(TOKEN));
    let mut browser = Command::new(node())
        .arg(script())
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    browser.stdin.take().unwrap().write_all(format!("{}\n", json!({"base":format!("http://{address}"),"url":url,"engagement":engagement,"executable":true})).as_bytes()).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(45), browser.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    server.kill().await.unwrap();
    server.wait().await.unwrap();
}
