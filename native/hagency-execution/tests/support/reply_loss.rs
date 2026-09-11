// Included by the library's test build so the receipt-discard seam cannot exist
// in a normal library. This is not an independently compiled integration test.
use crate::test_common::*;
use crate::{Failure, Host, Limits, Operation, Protocol, Settlement};
use hagency_core::tasks::*;
use hagency_store::{DomainRepository, DomainStore, EffectOutcome, OwnedObservation};
use serde_json::json;
use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};

#[tokio::test]
async fn native_owned_dispatch_lost_receipt_never_spawns() {
    lost_reply(false).await;
}
#[tokio::test]
async fn native_owned_usage_lost_binding_never_spawns() {
    lost_reply(true).await;
}
async fn lost_reply(usage: bool) {
    let root = tempfile::tempdir().unwrap();
    let work = root.path().canonicalize().unwrap();
    let mut db = DomainRepository::open(&root.path().join("state")).unwrap();
    db.register(&registration()).unwrap();
    let pool = resource("pool", "seat", 1000);
    db.put_resource(&pool).unwrap();
    let proof = proof(&request("allocated", "Worker", &pool, 100));
    let e = db.admit(&proof, 1000).unwrap();
    db.approve("approve", &proof, 1000).unwrap();
    let effect = db.claim_effect().unwrap().unwrap();
    db.observe_effect(
        &effect.id,
        effect.fence,
        &EffectOutcome::Applied {
            receipt: "offline".into(),
        },
    )
    .unwrap();
    db.register_session(&SessionBinding {
        id: "session".into(),
        engagement_id: e.id,
        room_id: "!project:example.test".into(),
        thread_root: None,
    })
    .unwrap();
    db.register_workspace("work").unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    db.create_canonical_task("task", "session", "Lost start response", now)
        .unwrap();
    db.enqueue_dispatch(&DispatchInput {
        id: "dispatch".into(),
        session_id: "session".into(),
        task_id: Some("task".into()),
        resources: vec![ResourceLease {
            id: "work".into(),
            exclusive: true,
        }],
        payload: json!({"instruction":"offline"}),
    })
    .unwrap();
    let cap = db
        .claim_dispatch("host", now, 60_000, 60_000, 1)
        .unwrap()
        .unwrap();
    let domain = DomainStore::start(db, 16).unwrap();
    let binary = std::env::current_exe().unwrap();
    let mut host = Host::new(
        binary.clone(),
        binary,
        BTreeMap::new(),
        BTreeMap::from([("work".into(), work)]),
    )
    .unwrap();
    host.discard_start_reply = !usage;
    host.discard_usage_binding_reply = usage;
    let mut operation = Operation::start(
        domain.clone(),
        cap,
        host,
        Limits {
            operation_ms: 5000,
            response_ms: 1000,
        },
    )
    .unwrap();
    let report = operation.wait().await.unwrap();
    assert_eq!(
        report.failure,
        Some(if usage {
            Failure::UsageBinding
        } else {
            Failure::StartUnknown
        })
    );
    assert_eq!(report.protocol, Protocol::NotStarted);
    assert_eq!(report.cleanup, hagency_runtime::owned::Cleanup::Pending);
    assert_eq!(
        report.settlement,
        Settlement::Negative(OwnedObservation::Fenced)
    );
    let inspect = rusqlite::Connection::open(root.path().join("state/domain.sqlite3")).unwrap();
    assert_eq!(
        inspect
            .query_row("SELECT COUNT(*) FROM usage_sources", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        u64::from(usage)
    );
    assert_eq!(
        inspect
            .query_row("SELECT COUNT(*) FROM usage_receipts", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        inspect
            .query_row("SELECT COUNT(*) FROM resource_leases", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        1
    );
    assert_eq!(inspect.query_row("SELECT COUNT(*) FROM canonical_tasks WHERE json_extract(config,'$.status')='in_progress'",[],|r|r.get::<_,u64>(0)).unwrap(),1);
    domain.shutdown().await.unwrap();
}
