//! Actual native service setup. Domain writes provision legitimate work only;
//! Collector refresh, compatible claim, Started binding, source registration and
//! runtime launch occur exclusively inside the real service process.
#[path = "../../../hagency-matrix/tests/common/mod.rs"]
pub mod common;
#[path = "../fixtures/matrix_crypto_peer.rs"]
pub mod crypto;
use hagency_core::{replies::*, tasks::*};
use hagency_store::{DomainRepository, EffectOutcome, private};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    net::SocketAddr,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
pub const DATA: &[u8] = b"original native file bytes\0\xff\x80\n";

pub struct Running(Option<Child>);
impl Running {
    /// Check only the original service PID. This is not process-tree cleanup.
    pub fn stop_and_reap(mut self) {
        let child = self.0.as_mut().unwrap();
        if child
            .try_wait()
            .expect("inspect original native child")
            .is_none()
        {
            child.kill().expect("terminate original native child");
        }
        child.wait().expect("reap original native child");
        self.0 = None;
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        // Best-effort panic cleanup; successful tests use checked stop_and_reap.
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
pub struct Fixture {
    pub root: tempfile::TempDir,
    pub state_dir: PathBuf,
    pub work: PathBuf,
    pub fake: common::Fake,
    pub address: SocketAddr,
    pub peer: crypto::Peer,
    pub room: String,
    pub ciphertext: Option<Vec<u8>>,
    pub uploads: usize,
    pub event_puts: usize,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
impl Fixture {
    /// An actual new native task client inherits the original disposable
    /// caller's context. This grants no new capability or current authority.
    pub(super) async fn historical_file(&self, delivery_id: &str) -> Value {
        let bytes = private::read_secret(&self.work.join("file-mcp.context")).unwrap();
        assert!(bytes.len() <= 8192);
        let inherited: std::collections::BTreeMap<String, String> =
            serde_json::from_slice(&bytes).unwrap();
        assert_eq!(inherited.len(), 4);
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_hagency"));
        command
            .arg("mcp")
            .env_clear()
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for key in [
            "HAGENCY_RUNNER_API_ADDR",
            "HAGENCY_RUNNER_CAPABILITY",
            "HAGENCY_TASK_ID",
            "HAGENCY_FILE_TOOLS",
        ] {
            command.env(
                key,
                inherited.get(key).expect("original fixed context field"),
            );
        }
        #[cfg(windows)]
        command.env("SystemRoot", std::env::var_os("SystemRoot").unwrap());
        let mut child = command.spawn().unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = child.stdout.take().unwrap();
        let mut errors = child.stderr.take().unwrap();
        for message in [
            json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"historical-file-fixture","version":"1"}}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_file_delivery","arguments":{"delivery_id":delivery_id}}}),
        ] {
            let mut bytes = serde_json::to_vec(&message).unwrap();
            bytes.push(b'\n');
            input.write_all(&bytes).await.unwrap();
        }
        drop(input);
        let status = match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(status) => status.unwrap(),
            Err(_) => {
                child.kill().await.unwrap();
                child.wait().await.unwrap();
                panic!("original-context historical MCP did not finish");
            }
        };
        assert!(status.success());
        let mut stdout = Vec::new();
        (&mut output)
            .take(16385)
            .read_to_end(&mut stdout)
            .await
            .unwrap();
        assert!(stdout.len() <= 16384);
        let mut stderr = Vec::new();
        (&mut errors)
            .take(4097)
            .read_to_end(&mut stderr)
            .await
            .unwrap();
        assert!(stderr.is_empty());
        let replies = stdout
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0]["id"], 0);
        assert!(replies[0].get("error").is_none());
        assert_eq!(replies[1]["id"], 1);
        assert!(replies[1].get("error").is_none());
        replies[1]["result"].clone()
    }

    pub async fn deliver(&mut self) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(40);
        let mut requests = 0usize;
        loop {
            if let Ok(bytes) = fs::read(self.work.join("file-mcp.receipt")) {
                return serde_json::from_slice(&bytes).unwrap();
            }
            if let Ok(request) =
                tokio::time::timeout(Duration::from_millis(50), self.fake.next()).await
            {
                requests += 1;
                assert!(requests <= 96, "unbounded native protocol loop");
                self.respond(request).await;
                continue;
            }
            // The model can atomically finish its receipt during the request
            // wait. Runtime/canonical settlement is a separate later boundary.
            if let Ok(bytes) = fs::read(self.work.join("file-mcp.receipt")) {
                return serde_json::from_slice(&bytes).unwrap();
            }
            let status = self.capabilities().await["development_execution"].clone();
            assert!(
                !matches!(
                    status["state"].as_str(),
                    Some("unavailable" | "outcome_unknown" | "no_work")
                ),
                "actual file workflow refused; this is not a positive delivery: {status}; key writes={}, claims={}, shares={}, upload={}",
                self.peer.writes.len(),
                self.peer.claims,
                self.peer.shares,
                self.ciphertext.is_some()
            );
            assert!(
                tokio::time::Instant::now() < deadline,
                "actual file workflow did not deliver: {status}"
            );
        }
    }

    pub(super) async fn respond(&mut self, request: common::Request) {
        assert_eq!(
            request.headers.get("authorization"),
            Some(&format!("Bearer {}", common::TOKEN))
        );
        assert!(!request.target.contains(common::TOKEN));
        match (request.method.as_str(), request.target.as_str()) {
            ("GET", "/_matrix/client/v3/account/whoami") => request.json(200, common::who()),
            ("GET", target) if target.starts_with("/_matrix/client/v3/sync?") => {
                request.json(200, common::sync("native-file"))
            }
            ("GET", target)
                if target.starts_with("/_matrix/client/v3/rooms/")
                    && target.ends_with("/state") =>
            {
                request.json(200, common::state())
            }
            ("POST", "/_matrix/media/v3/upload") => {
                self.observe_upload(&request);
                request.json(200, json!({"content_uri":"mxc://example.test/native-file"}));
            }
            ("PUT", target)
                if target.starts_with("/_matrix/client/v3/sendToDevice/m.room.encrypted/") =>
            {
                self.peer
                    .share(serde_json::from_slice(&request.body).unwrap())
                    .await;
                request.json(200, json!({}));
            }
            ("PUT", target)
                if target.starts_with("/_matrix/client/v3/rooms/")
                    && target.contains("/send/m.room.encrypted/") =>
            {
                self.observe_event(&request).await;
                request.json(200, json!({"event_id":"$native_file_accepted"}));
            }
            _ => {
                let body = if request.body.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&request.body).unwrap()
                };
                let (status, response) = self
                    .peer
                    .protocol(&request.method, &request.target, &body)
                    .await
                    .unwrap_or_else(|| {
                        panic!(
                            "unhandled actual Matrix route {} {}",
                            request.method, request.target
                        )
                    });
                request.json(status, response);
            }
        }
    }

    pub(super) fn observe_upload(&mut self, request: &common::Request) {
        assert_eq!(
            request.headers.get("authorization"),
            Some(&format!("Bearer {}", common::TOKEN))
        );
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/_matrix/media/v3/upload");
        assert!(self.ciphertext.is_none(), "duplicate media POST");
        assert_eq!(request.headers["content-type"], "application/octet-stream");
        assert_eq!(request.body.len(), DATA.len());
        assert_ne!(request.body, DATA);
        self.uploads += 1;
        assert_eq!(self.uploads, 1);
        self.ciphertext = Some(request.body.clone());
    }
    pub(super) async fn observe_event(&mut self, request: &common::Request) {
        assert_eq!(
            request.headers.get("authorization"),
            Some(&format!("Bearer {}", common::TOKEN))
        );
        assert_eq!(request.method, "PUT");
        assert!(
            request.target.starts_with("/_matrix/client/v3/rooms/")
                && request.target.contains("/send/m.room.encrypted/")
        );
        assert!(self.ciphertext.is_some());
        self.event_puts += 1;
        assert_eq!(self.event_puts, 1, "duplicate encrypted event PUT");
        self.peer
            .decrypt(
                serde_json::from_slice(&request.body).unwrap(),
                ruma::RoomId::parse(&self.room).unwrap().as_ref(),
            )
            .await;
        // Even actual recipient decryption cannot replace the event ACK.
        assert_eq!(self.delivered_count(), 0);
    }
    /// Retain the actual server response sender while the original service
    /// awaits it. This pauses no other task and supplies no synthetic outcome.
    pub(super) async fn pause_write(&mut self, event: bool) -> common::Request {
        let until = tokio::time::Instant::now() + Duration::from_secs(20);
        for _ in 0..96 {
            let request = tokio::time::timeout_at(until, self.fake.next())
                .await
                .expect("actual native write was not reached");
            let selected = if event {
                request.method == "PUT"
                    && request.target.starts_with("/_matrix/client/v3/rooms/")
                    && request.target.contains("/send/m.room.encrypted/")
            } else {
                request.method == "POST" && request.target == "/_matrix/media/v3/upload"
            };
            if selected {
                if event {
                    self.observe_event(&request).await;
                } else {
                    self.observe_upload(&request);
                }
                return request;
            }
            self.respond(request).await;
        }
        panic!("bounded original write request count exceeded");
    }

    pub(super) fn delivered_count(&self) -> u64 {
        self.sql()
            .query_row(
                "SELECT COUNT(*) FROM file_deliveries WHERE event_state='delivered'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }
    pub async fn new(direct: bool) -> Self {
        let peer = crypto::Peer::new().await;
        let room = if direct {
            "!direct:example.test"
        } else {
            "!project:example.test"
        };
        let privacy = if direct {
            RoomPrivacy::Direct {
                human_mxid: "@owner:example.test".into(),
            }
        } else {
            RoomPrivacy::Group {}
        };
        let root = tempfile::tempdir().unwrap();
        let state_dir = root.path().join("state");
        let init = Command::new(env!("CARGO_BIN_EXE_hagency"))
            .args(["init", "--state-dir"])
            .arg(&state_dir)
            .output()
            .unwrap();
        assert!(
            init.status.success(),
            "init failed: {}",
            String::from_utf8_lossy(&init.stderr)
        );
        let work = root.path().join("工作目录");
        private::directory(&work).unwrap();
        let work = work.canonicalize().unwrap();
        let mut db = DomainRepository::open(&state_dir).unwrap();
        db.register(&common::domain::registration()).unwrap();
        let resource = common::domain::resource("pool", "seat", 1000);
        db.put_resource(&resource).unwrap();
        let request = common::domain::request("bootstrap", "Worker", &resource, 100);
        let mut observation = common::domain::observation(&request);
        observation.observed_at_ms = now();
        let proof = hagency_core::authority::verify_request(
            &common::domain::registration(),
            request,
            observation,
        )
        .unwrap();
        let e = db.admit(&proof, now()).unwrap();
        db.approve("approve", &proof, now()).unwrap();
        let effect = db.claim_effect().unwrap().unwrap();
        db.observe_effect(
            &effect.id,
            effect.fence,
            &EffectOutcome::Applied {
                receipt: "fixture provision".into(),
            },
        )
        .unwrap();
        let transport = MatrixTransportObservation {
            engagement_id: e.id.clone(),
            registration_generation: 1,
            generation: 1,
            sender_mxid: "@worker:example.test".into(),
            device_id: "DEVICE_1".into(),
        };
        db.observe_matrix_transport(&transport, now()).unwrap();
        db.observe_matrix_room(
            &MatrixRoomObservation {
                engagement_id: e.id.clone(),
                registration_generation: 1,
                transport_generation: 1,
                room_id: room.into(),
                generation: 1,
                privacy: privacy.clone(),
                joined: BTreeSet::from([
                    "@worker:example.test".into(),
                    "@owner:example.test".into(),
                ]),
                invite_only: true,
                encrypted: true,
            },
            now(),
        )
        .unwrap();
        db.resolve_verified_matrix_session(
            &SessionBinding {
                id: "session".into(),
                engagement_id: e.id.clone(),
                room_id: room.into(),
                thread_root: (!direct).then(|| "$task_thread".into()),
            },
            now(),
        )
        .unwrap();
        db.create_canonical_task("task", "session", "Native bootstrap task", now())
            .unwrap();
        db.register_workspace("work").unwrap();
        db.enqueue_dispatch(&DispatchInput{id:"dispatch".into(),session_id:"session".into(),task_id:Some("task".into()),resources:vec![ResourceLease{id:"work".into(),exclusive:true}],payload:json!({"instruction":"Send sample.bin using native MCP and inspect its delivery status. Leave the canonical task in progress."})}).unwrap();
        drop(db); // No issued cap, Started restoration, SQL availability or handoff.
        let fake = common::Fake::start(true).await;
        let executable = PathBuf::from(env!("CARGO_BIN_EXE_hagency-file-mcp-probe"))
            .canonicalize()
            .unwrap();
        let executable_sha256: String = Sha256::digest(fs::read(&executable).unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let config = json!({"profile":"codex_app_server_development_v1","send_file":true,"executable":executable,"executable_sha256":executable_sha256,"workspaces":{"work":work},"file_limit":4194304,"operation_ms":10000,"response_ms":1500,
            "matrix":{"origin":fake.endpoint,"server_name":"example.test","registration_fingerprint":"a".repeat(64),"engagement_id":e.id,"registration_generation":1,"transport_generation":1,"sender_mxid":"@worker:example.test","device_id":"DEVICE_1","crypto_enrollment":{"profile":"fresh_own_account_v1","peer_masters":[{"user_id":"@owner:example.test","master_key":peer.anchor()}]},"rooms":[{"id":room,"generation":1,"privacy":privacy}]}});
        private::write_new(
            &state_dir.join("development-driver.json"),
            &serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        private::write_new(
            &state_dir.join("matrix.access_token"),
            common::TOKEN.as_bytes(),
        )
        .unwrap();
        private::write_new(&state_dir.join("matrix.sdk_key"), &[42; 32]).unwrap();
        private::write_new(
            &state_dir.join("matrix.ca.pem"),
            include_bytes!("../../../hagency-matrix/tests/fixtures/ca.pem"),
        )
        .unwrap();
        let reserve = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = reserve.local_addr().unwrap();
        drop(reserve);
        private::write_new(&work.join("sample.bin"), DATA).unwrap();
        Self {
            peer,
            room: room.into(),
            ciphertext: None,
            uploads: 0,
            event_puts: 0,
            root,
            state_dir,
            work,
            fake,
            address,
        }
    }
    pub fn command(&self, enabled: bool) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hagency"));
        command
            .args(["serve", "--state-dir"])
            .arg(&self.state_dir)
            .args(["--listen", &self.address.to_string()]);
        if enabled {
            command.arg("--development-driver");
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }
    pub fn launch(&self, enabled: bool) -> Running {
        let file = private::open(&self.root.path().join("native.stderr"), true).unwrap();
        Running(Some(
            self.command(enabled)
                .stderr(Stdio::from(file))
                .spawn()
                .unwrap(),
        ))
    }
    pub(super) fn sql(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.state_dir.join("domain.sqlite3")).unwrap()
    }
    pub fn state(&self) -> String {
        self.sql()
            .query_row(
                "SELECT state FROM runner_dispatches WHERE id='dispatch'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }
    pub fn attempts(&self) -> u64 {
        self.sql()
            .query_row("SELECT COUNT(*) FROM runner_attempts", [], |r| r.get(0))
            .unwrap()
    }
    pub async fn capabilities(&self) -> Value {
        let until = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(mut stream) = tokio::net::TcpStream::connect(self.address).await {
                let token = String::from_utf8(
                    private::read_secret(&self.state_dir.join("operator.token")).unwrap(),
                )
                .unwrap();
                stream.write_all(format!("GET /api/native/v1/capabilities HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",self.address,token).as_bytes()).await.unwrap();
                let mut bytes = Vec::new();
                tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut bytes))
                    .await
                    .unwrap()
                    .unwrap();
                let response = String::from_utf8(bytes).unwrap();
                if response.starts_with("HTTP/1.1 200") {
                    return serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1)
                        .unwrap();
                }
            }
            assert!(
                tokio::time::Instant::now() < until,
                "native bootstrap did not serve capabilities: {}",
                {
                    use std::io::Read;
                    let mut bytes = Vec::new();
                    if let Ok(file) = fs::File::open(self.root.path().join("native.stderr")) {
                        file.take(8192).read_to_end(&mut bytes).unwrap();
                    }
                    String::from_utf8_lossy(&bytes).into_owned()
                }
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    pub async fn wait_result(&self) -> Value {
        let until = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let status = self.capabilities().await["development_execution"].clone();
            if matches!(
                status["state"].as_str(),
                Some("completed" | "unavailable" | "outcome_unknown" | "no_work")
            ) {
                return status;
            }
            assert!(
                tokio::time::Instant::now() < until,
                "native driver did not report its result"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
