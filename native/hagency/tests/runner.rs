#[path = "../../hagency-store/tests/common/mod.rs"]
mod common;
use common::*;
use hagency::App;
use hagency_core::{messages::*, tasks::*};
use hagency_store::{DomainRepository, DomainStore, EffectOutcome, Repository, Store};
use salvo::{
    prelude::*,
    test::{RequestBuilder, ResponseExt, TestClient},
};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

const TOKEN: &str = "fixture_operator_token_32_bytes_minimum";
const BASE: &str = "http://127.0.0.1:13300/api/native/v1";
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
struct Fixture {
    _root: tempfile::TempDir,
    service: Service,
    domain: DomainStore,
    custody: Store,
    cap: RunnerCapability,
    engagement: String,
}
impl Fixture {
    async fn new(start: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state");
        let custody = Store::start(Repository::open(&state).unwrap(), 16).unwrap();
        let mut db = DomainRepository::open(&state).unwrap();
        db.register(&registration()).unwrap();
        let pool = resource("pool", "seat", 1000);
        db.put_resource(&pool).unwrap();
        let proof = proof(&request("request", "小白", &pool, 100));
        let e = db.admit(&proof, 1000).unwrap();
        db.approve("approve", &proof, 1000).unwrap();
        let effect = db.claim_effect().unwrap().unwrap();
        db.observe_effect(
            &effect.id,
            effect.fence,
            &EffectOutcome::Applied {
                receipt: "fixture_provisioned".into(),
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
        let current = now();
        db.create_canonical_task("task", "session", "Verify the implementation", current)
            .unwrap();
        db.create_canonical_task(
            "private_other_task",
            "session",
            "Not in this dispatch",
            current,
        )
        .unwrap();
        let source = InboundMessage {
            server_name: "example.test".into(),
            room_id: "!project:example.test".into(),
            event_id: "$source".into(),
            sender_mxid: "@owner:example.test".into(),
            thread_root: Some("$thread".into()),
            body: "Please verify the code".into(),
            kind: "m.text".into(),
            origin_ts: current,
        };
        let receipt = db
            .ingest_message(
                &source,
                &[MessageTarget {
                    session_id: "session".into(),
                    wake: true,
                }],
                current,
            )
            .unwrap();
        db.enqueue_inbox_dispatch(
            &DispatchInput {
                id: "dispatch".into(),
                session_id: "session".into(),
                task_id: Some("task".into()),
                resources: vec![],
                payload: json!({"instruction":"verify"}),
            },
            &[receipt.sequence],
        )
        .unwrap();
        let cap = db
            .claim_dispatch("runner", current, 120_000, 120_000, 8)
            .unwrap()
            .unwrap();
        if start {
            db.start_dispatch(&cap, current).unwrap();
        }
        let domain = DomainStore::start(db, 16).unwrap();
        let service = Service::new(
            App::new(
                custody.clone(),
                TOKEN.as_bytes(),
                "127.0.0.1:13300".parse().unwrap(),
            )
            .unwrap()
            .with_domain(domain.clone())
            .router(),
        );
        Self {
            _root: root,
            service,
            domain,
            custody,
            cap,
            engagement: e.id,
        }
    }
    async fn close(self) {
        self.domain.shutdown().await.unwrap();
        self.custody.shutdown().await.unwrap();
    }
}
fn auth(builder: RequestBuilder, cap: &RunnerCapability) -> RequestBuilder {
    builder
        .add_header("host", "127.0.0.1:13300", true)
        .bearer_auth(&cap.secret)
        .add_header("x-hagency-dispatch", &cap.dispatch_id, true)
        .add_header("x-hagency-runner", &cap.runner_id, true)
        .add_header("x-hagency-fence", cap.fence.to_string(), true)
}
fn get(path: &str, cap: &RunnerCapability) -> RequestBuilder {
    auth(TestClient::get(format!("{BASE}/runner/{path}")), cap)
}
fn post(id: &str, cap: &RunnerCapability, body: &Value) -> RequestBuilder {
    auth(
        TestClient::post(format!("{BASE}/runner/tasks/{id}/operations")),
        cap,
    )
    .json(body)
}
async fn operation(f: &Fixture, call: &str, operation: Value) -> (StatusCode, Value) {
    let mut response = post(
        "task",
        &f.cap,
        &json!({"call_id":call,"operation":operation}),
    )
    .send(&f.service)
    .await;
    let code = response.status_code.unwrap();
    (code, response.take_json().await.unwrap())
}

#[tokio::test]
async fn native_runner_http_authority() {
    let f = Fixture::new(true).await;
    let mut valid = get("tasks", &f.cap).send(&f.service).await;
    assert_eq!(valid.status_code, Some(StatusCode::OK));
    assert_eq!(valid.headers()["cache-control"], "no-store");
    let text = valid.take_string().await.unwrap();
    assert!(!text.contains(&f.cap.secret));
    assert!(!text.contains(TOKEN));
    assert!(!text.contains("private_other_task"));
    for builder in [
        TestClient::get(format!("{BASE}/runner/tasks")),
        TestClient::get(format!("{BASE}/runner/tasks")).bearer_auth(TOKEN),
        TestClient::get(format!("{BASE}/runner/tasks?capability={}", f.cap.secret)),
    ] {
        let response = builder
            .add_header("host", "127.0.0.1:13300", true)
            .send(&f.service)
            .await;
        assert_eq!(response.status_code, Some(StatusCode::UNAUTHORIZED));
    }
    for (name, value) in [
        ("origin", "https://attacker.test"),
        ("sec-fetch-site", "same-origin"),
        ("forwarded", "for=127.0.0.1"),
        ("x-forwarded-for", "127.0.0.1"),
        ("host", "attacker.test:13300"),
    ] {
        assert_eq!(
            get("tasks", &f.cap)
                .add_header(name, value, true)
                .send(&f.service)
                .await
                .status_code,
            Some(StatusCode::FORBIDDEN)
        );
    }
    for name in [
        "authorization",
        "x-hagency-dispatch",
        "x-hagency-runner",
        "x-hagency-fence",
    ] {
        assert_eq!(
            get("tasks", &f.cap)
                .add_header(name, "duplicate", false)
                .send(&f.service)
                .await
                .status_code,
            Some(StatusCode::UNAUTHORIZED),
            "{name}"
        );
    }
    assert_eq!(
        get("tasks", &f.cap)
            .add_header("host", "127.0.0.1:13300", false)
            .send(&f.service)
            .await
            .status_code,
        Some(StatusCode::FORBIDDEN)
    );
    assert_eq!(
        get("tasks?secret=discard_me", &f.cap)
            .send(&f.service)
            .await
            .status_code,
        Some(StatusCode::UNAUTHORIZED)
    );
    let bad = RunnerCapability {
        fence: f.cap.fence + 1,
        ..f.cap.clone()
    };
    assert_eq!(
        get("tasks", &bad).send(&f.service).await.status_code,
        Some(StatusCode::UNAUTHORIZED)
    );
    assert_eq!(
        auth(TestClient::get(format!("{BASE}/resources")), &f.cap)
            .send(&f.service)
            .await
            .status_code,
        Some(StatusCode::UNAUTHORIZED)
    );
    for path in ["claim", "start", "recover", "sessions", "resources"] {
        let response = auth(TestClient::post(format!("{BASE}/runner/{path}")), &f.cap)
            .json(&json!({}))
            .send(&f.service)
            .await;
        assert!(response.status_code.unwrap().is_client_error(), "{path}");
    }
    f.domain
        .park_dispatch(f.cap.clone(), true, now())
        .await
        .unwrap();
    assert_eq!(
        get("tasks", &f.cap).send(&f.service).await.status_code,
        Some(StatusCode::UNAUTHORIZED)
    );
    f.domain
        .park_dispatch(f.cap.clone(), false, now())
        .await
        .unwrap();
    f.domain
        .revoke("revoke".into(), f.engagement.clone())
        .await
        .unwrap();
    assert_eq!(
        get("tasks", &f.cap).send(&f.service).await.status_code,
        Some(StatusCode::UNAUTHORIZED)
    );
    f.close().await;
    let early = Fixture::new(false).await;
    assert_eq!(
        get("tasks", &early.cap)
            .send(&early.service)
            .await
            .status_code,
        Some(StatusCode::UNAUTHORIZED)
    );
    early.close().await;
}

#[tokio::test]
async fn native_runner_http_task_lifecycle() {
    let f = Fixture::new(true).await;
    let mut task = get("tasks/task", &f.cap).send(&f.service).await;
    assert_eq!(
        task.take_json::<Value>().await.unwrap()["status"],
        "in_progress"
    );
    for id in ["private_other_task", "not_found"] {
        let mut response = get(&format!("tasks/{id}"), &f.cap).send(&f.service).await;
        assert_eq!(response.status_code, Some(StatusCode::FORBIDDEN));
        assert_eq!(
            response.take_json::<Value>().await.unwrap(),
            json!({"ok":false,"code":"task_scope_required"})
        );
        assert_eq!(
            post(
                id,
                &f.cap,
                &json!({"call_id":"no","operation":{"action":"transition","status":"done"}})
            )
            .send(&f.service)
            .await
            .status_code,
            Some(StatusCode::FORBIDDEN)
        );
    }
    let before = now();
    let (code, beat) = operation(&f, "beat", json!({"action":"execution","heartbeat":true})).await;
    assert_eq!(code, StatusCode::OK);
    assert!(beat["task"]["heartbeat_at"].as_u64().unwrap() >= before);
    let (code, comment) = operation(
        &f,
        "comment",
        json!({"action":"comment","text":"Acceptance checks passed"}),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(comment["replayed"], false);
    let (_, replayed) = operation(
        &f,
        "comment",
        json!({"action":"comment","text":"Acceptance checks passed"}),
    )
    .await;
    assert_eq!(replayed["replayed"], true);
    assert_eq!(
        operation(&f, "comment", json!({"action":"comment","text":"changed"}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut comments = get("tasks/task/comments?limit=1", &f.cap)
        .send(&f.service)
        .await;
    let comments: Value = comments.take_json().await.unwrap();
    assert_eq!(comments[0]["author"], "小白");
    assert_eq!(comments.as_array().unwrap().len(), 1);
    assert_eq!(operation(&f,"blocked",json!({"action":"transition","status":"blocked","waiting_reason":"dependency","waiting_until":"2026-10-01T00:00:00Z"})).await.0,StatusCode::OK);
    assert_eq!(
        operation(
            &f,
            "resume",
            json!({"action":"transition","status":"in_progress"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (code, done) = operation(&f, "done", json!({"action":"transition","status":"done"})).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(done["task"]["execution_epoch"], 1);
    assert_eq!(done["task"]["status"], "done");
    assert_eq!(
        operation(&f, "done", json!({"action":"transition","status":"done"}))
            .await
            .1["replayed"],
        true
    );
    f.domain
        .complete_dispatch(f.cap.clone(), json!({"text":"reported"}), now())
        .await
        .unwrap();
    assert_eq!(
        get("tasks/task", &f.cap).send(&f.service).await.status_code,
        Some(StatusCode::UNAUTHORIZED)
    );
    f.close().await;
}

#[tokio::test]
async fn native_runner_http_inbox_and_limits() {
    let f = Fixture::new(true).await;
    let mut inbox = get("inbox?limit=1", &f.cap).send(&f.service).await;
    let first: Value = inbox.take_json().await.unwrap();
    assert_eq!(first.as_array().unwrap().len(), 1);
    let seq = first[0]["message"]["sequence"].as_u64().unwrap();
    let source = InboundMessage {
        server_name: "example.test".into(),
        room_id: "!project:example.test".into(),
        event_id: "$later".into(),
        sender_mxid: "@owner:example.test".into(),
        thread_root: Some("$thread".into()),
        body: "Later instruction".into(),
        kind: "m.text".into(),
        origin_ts: now(),
    };
    f.domain
        .ingest_message(
            source,
            vec![MessageTarget {
                session_id: "session".into(),
                wake: true,
            }],
            now(),
        )
        .await
        .unwrap();
    let mut later = get(&format!("inbox?after={seq}"), &f.cap)
        .send(&f.service)
        .await;
    assert_eq!(later.take_json::<Value>().await.unwrap(), json!([]));
    for path in [
        "tasks?limit=101",
        "tasks?limit=invalid",
        "inbox?after=not_an_integer",
        "tasks/task/comments?limit=0",
    ] {
        assert_eq!(
            get(path, &f.cap).send(&f.service).await.status_code,
            Some(StatusCode::BAD_REQUEST)
        );
    }
    for body in [
        json!({"call_id":"bad","operation":{"action":"comment","text":"spoof","author":"operator"}}),
        json!({"call_id":"bad","operation":{"action":"execution","heartbeat":true,"status":"done"}}),
        json!({"call_id":"bad","operation":{"action":"approve_all"}}),
        json!({"call_id":"bad","now":0,"operation":{"action":"transition","status":"done"}}),
    ] {
        assert_eq!(
            post("task", &f.cap, &body)
                .send(&f.service)
                .await
                .status_code,
            Some(StatusCode::BAD_REQUEST)
        );
    }
    assert_eq!(
        auth(
            TestClient::post(format!("{BASE}/runner/tasks/task/operations")),
            &f.cap
        )
        .body("plain text")
        .send(&f.service)
        .await
        .status_code,
        Some(StatusCode::UNSUPPORTED_MEDIA_TYPE)
    );
    assert_eq!(
        post(
            "task",
            &f.cap,
            &json!({"call_id":"large","operation":{"action":"comment","text":"x".repeat(65*1024)}})
        )
        .send(&f.service)
        .await
        .status_code,
        Some(StatusCode::PAYLOAD_TOO_LARGE)
    );
    let mut comments = get("tasks/task/comments", &f.cap).send(&f.service).await;
    assert_eq!(comments.take_json::<Value>().await.unwrap(), json!([]));
    f.domain
        .complete_dispatch(f.cap.clone(), json!({"text":"All done!"}), now())
        .await
        .unwrap();
    let inspect = rusqlite::Connection::open(f._root.path().join("state/domain.sqlite3")).unwrap();
    assert_eq!(
        inspect
            .query_row(
                "SELECT json_extract(config,'$.status') FROM canonical_tasks WHERE id='task'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "in_progress"
    );
    drop(inspect);
    f.close().await;
}
