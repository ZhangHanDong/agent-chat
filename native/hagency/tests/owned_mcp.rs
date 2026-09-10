#[path = "../../hagency-store/tests/common/mod.rs"]
mod common;
use common::*;
use hagency_core::tasks::*;
use hagency_execution::{Failure, Host, Limits, Operation, Protocol, Settlement};
use hagency_runtime::owned::Cleanup;
use hagency_store::{DomainRepository, DomainStore, EffectOutcome, OwnedObservation};
use salvo::Listener;
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn binary() -> PathBuf {
    env!("CARGO_BIN_EXE_hagency-owned-mcp-probe").into()
}
fn limits() -> Limits {
    Limits {
        operation_ms: 30_000,
        response_ms: 2000,
    }
}
struct Fixture {
    root: tempfile::TempDir,
    work: PathBuf,
    domain: DomainStore,
    cap: RunnerCapability,
    custody: hagency_store::Store,
    handle: salvo::server::ServerHandle,
    server: tokio::task::JoinHandle<()>,
    address: std::net::SocketAddr,
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().join("固定 工作目录");
        fs::create_dir(&work).unwrap();
        let work = work.canonicalize().unwrap();
        let custody = hagency_store::Store::start(
            hagency_store::Repository::open(&root.path().join("state")).unwrap(),
            16,
        )
        .unwrap();
        let mut db = DomainRepository::open(&root.path().join("state")).unwrap();
        db.register(&registration()).unwrap();
        let pool = resource("pool", "seat", 1000);
        db.put_resource(&pool).unwrap();
        let proof = proof(&request("allocation", "Worker", &pool, 100));
        let e = db.admit(&proof, 1000).unwrap();
        db.approve("approved", &proof, 1000).unwrap();
        let effect = db.claim_effect().unwrap().unwrap();
        db.observe_effect(
            &effect.id,
            effect.fence,
            &EffectOutcome::Applied {
                receipt: "offline_provisioned".into(),
            },
        )
        .unwrap();
        db.register_session(&SessionBinding {
            id: "session".into(),
            engagement_id: e.id.clone(),
            room_id: "!project:example.test".into(),
            thread_root: Some("$thread".into()),
        })
        .unwrap();
        db.register_workspace("work").unwrap();
        db.create_canonical_task("task", "session", "Exact frozen task", now())
            .unwrap();
        db.enqueue_dispatch(&DispatchInput { id: "dispatch".into(), session_id: "session".into(), task_id: Some("task".into()), resources: vec![ResourceLease { id:"work".into(), exclusive:true }], payload: json!({"instruction":"do the offline work", "task_id":"impostor", "cwd":"/model/override", "model":"model-override", "done":true}) }).unwrap();
        let cap = db
            .claim_dispatch("owned_host", now(), 60_000, 60_000, 1)
            .unwrap()
            .unwrap();
        let domain = DomainStore::start(db, 16).unwrap();
        let acceptor = salvo::conn::TcpListener::new("127.0.0.1:0")
            .try_bind()
            .await
            .unwrap();
        let address = acceptor.local_addr().unwrap();
        let app = hagency::App::new(
            custody.clone(),
            b"fixture_operator_token_32_bytes_minimum",
            address,
        )
        .unwrap()
        .with_domain(domain.clone());
        let server = salvo::Server::new(acceptor);
        let handle = server.handle();
        let server = tokio::spawn(async move {
            server.try_serve(app.router()).await.unwrap();
        });
        Self {
            root,
            work,
            domain,
            cap,
            custody,
            handle,
            server,
            address,
        }
    }
    fn host(&self, mode: &str, reserved: bool) -> Host {
        let mut environment = BTreeMap::from([
            ("PATH".into(), "".into()),
            ("HAGENCY_OFFLINE_MODE".into(), mode.into()),
        ]);
        #[cfg(windows)]
        environment.insert("SystemRoot".into(), std::env::var_os("SystemRoot").unwrap());
        if reserved {
            environment.insert("hagency_runner_capability".into(), "impostor".into());
        }
        Host::new(
            binary(),
            binary(),
            environment,
            BTreeMap::from([("work".into(), self.work.clone())]),
        )
        .unwrap()
    }
    async fn close(self) {
        self.handle.stop_graceful(Some(Duration::from_secs(1)));
        self.server.await.unwrap();
        self.domain.shutdown().await.unwrap();
        self.custody.shutdown().await.unwrap();
    }
    fn sql(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.root.path().join("state/domain.sqlite3")).unwrap()
    }
    fn state(&self) -> String {
        self.sql()
            .query_row(
                "SELECT state FROM runner_dispatches WHERE id='dispatch'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }
    fn count(&self, query: &str) -> u64 {
        self.sql().query_row(query, [], |r| r.get(0)).unwrap()
    }
}

#[tokio::test]
async fn native_owned_mcp_configuration_admission() {
    let f = Fixture::new().await;
    let helper = PathBuf::from(env!("CARGO_BIN_EXE_hagency"));
    for address in [
        "192.0.2.1:1234",
        "0.0.0.0:1234",
        "127.0.0.1:0",
        "[::1%1]:1234",
    ] {
        assert!(
            f.host("heartbeat", false)
                .with_task_helper(helper.clone(), address.parse().unwrap())
                .is_err()
        );
    }
    assert!(
        f.host("heartbeat", true)
            .with_task_helper(helper.clone(), f.address)
            .is_err()
    );
    assert!(
        f.host("heartbeat", false)
            .with_task_helper("relative".into(), f.address)
            .is_err()
    );
    assert!(
        f.host("heartbeat", false)
            .with_task_helper(f.work.clone(), f.address)
            .is_err()
    );
    assert!(
        f.host("heartbeat", false)
            .with_task_helper(f.work.join("absent"), f.address)
            .is_err()
    );
    assert_eq!(f.state(), "leased");
    assert!(!f.work.join("owned-mcp.requests").exists());
    f.close().await;
}
async fn roundtrip(done: bool) {
    let f = Fixture::new().await;
    let host = f
        .host(if done { "done" } else { "heartbeat" }, false)
        .with_task_helper(env!("CARGO_BIN_EXE_hagency").into(), f.address)
        .unwrap();
    let initial_epoch = f
        .domain
        .owned_dispatch_scope(f.cap.clone())
        .await
        .unwrap()
        .task()
        .execution_epoch;
    let mut operation = Operation::start(f.domain.clone(), f.cap.clone(), host, limits()).unwrap();
    let report = operation.wait().await.unwrap();
    let task: Task = serde_json::from_str(
        &f.sql()
            .query_row(
                "SELECT config FROM canonical_tasks WHERE id='task'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    let mut observations = Vec::new();
    for stage in ["ack", "readback", "receipt"] {
        let path = f.work.join(format!("owned-mcp.{stage}"));
        let content = match fs::read_to_string(path) {
            Ok(value) => Some(value),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => panic!("fixture observation failed: {error}"),
        };
        if let Some(content) = content {
            assert!(!content.contains(&f.cap.secret));
            let value: serde_json::Value = serde_json::from_str(&content).unwrap();
            assert_eq!(value["task"], serde_json::to_value(&task).unwrap());
            if stage == "receipt" {
                assert_eq!(value["helper_exit"], true);
            }
            observations.push(stage);
        }
    }
    if done {
        // Real renewal may stop the old runtime as soon as Done advances its
        // epoch, even before the native helper receives its response. No fake
        // gate delays revocation. Missing acknowledgement/exit remains unknown.
        eprintln!("Done helper stages actually observed: {observations:?}");
    } else {
        assert_eq!(
            observations,
            ["ack", "readback", "receipt"],
            "heartbeat must confirm real helper response, readback and exit"
        );
    }
    assert_eq!(task.execution_epoch, initial_epoch + u64::from(done));
    assert_eq!(report.canonical_status, Some(task.status));
    assert_eq!(f.count("SELECT COUNT(*) FROM final_replies"), 0);
    if done {
        assert_eq!(task.status, TaskState::Done);
        assert_eq!(report.failure, Some(Failure::LostAuthority));
        assert_eq!(report.protocol, Protocol::Unknown);
        assert_eq!(
            report.settlement,
            Settlement::Negative(OwnedObservation::Fenced)
        );
        assert_eq!(f.state(), "outcome_unknown");
        assert_eq!(f.count("SELECT fence FROM dispatch_stops WHERE dispatch_id='dispatch' AND reason='owned_runner_failure'"),f.cap.fence);
        assert_eq!(
            f.count("SELECT capability_hash IS NULL FROM runner_dispatches WHERE id='dispatch'"),
            1
        );
        assert!(f.domain.owned_dispatch_scope(f.cap.clone()).await.is_err());
        assert_eq!(
            f.count("SELECT dirty FROM workspace_resources WHERE id='work'"),
            1
        );
        assert_eq!(f.count("SELECT COUNT(*) FROM resource_leases"), 1);
        assert_eq!(
            f.count("SELECT COUNT(*) FROM runner_outputs WHERE accepted=1"),
            0
        );
    } else {
        assert_eq!(task.status, TaskState::InProgress);
        assert!(task.heartbeat_at.is_some());
        assert_eq!(report.protocol, Protocol::Completed);
        let Cleanup::Observed(cleanup) = report.cleanup else {
            panic!("actual cleanup observation required");
        };
        assert!(cleanup.scope.leader_exited);
        if cfg!(target_os = "macos") {
            assert!(!cleanup.scope.whole_tree_stopped);
            assert_eq!(report.failure, Some(Failure::CleanupUnknown));
            assert_eq!(
                report.settlement,
                Settlement::Negative(OwnedObservation::Fenced)
            );
            assert_eq!(f.count("SELECT COUNT(*) FROM resource_leases"), 1);
        } else {
            assert!(cleanup.scope.whole_tree_stopped);
            assert_eq!(report.failure, None);
            assert_eq!(report.settlement, Settlement::Completed);
            assert_eq!(f.count("SELECT COUNT(*) FROM resource_leases"), 0);
        }
    }
    let requests = fs::read_to_string(f.work.join("owned-mcp.requests")).unwrap();
    assert!(!requests.contains(&f.cap.secret));
    assert!(!report.text.as_deref().unwrap_or("").contains(&f.cap.secret));
    let values: Vec<serde_json::Value> = requests
        .lines()
        .map(|v| serde_json::from_str(v).unwrap())
        .collect();
    let thread = values
        .iter()
        .find(|v| v["method"] == "thread/start")
        .unwrap();
    assert_eq!(thread["params"]["model"], "gpt-5.6-sol");
    assert_eq!(thread["params"]["cwd"], f.work.to_str().unwrap());
    assert!(
        thread["params"]["developerInstructions"]
            .as_str()
            .unwrap()
            .contains("task ID is task.")
    );
    let turn = values.iter().find(|v| v["method"] == "turn/start").unwrap();
    assert!(
        turn["params"]["input"][0]["text"]
            .as_str()
            .unwrap()
            .contains("impostor")
    );
    drop(report);
    drop(operation);
    f.close().await;
}
#[tokio::test]
async fn native_owned_mcp_real_heartbeat() {
    roundtrip(false).await;
}
#[tokio::test]
async fn native_owned_mcp_real_done_epoch() {
    roundtrip(true).await;
}
