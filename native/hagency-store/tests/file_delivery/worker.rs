use super::*;
use clock_fixtures::{proof, registration, request, resource};
use hagency_core::uploads::*;
use serde_json::json;
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn fixture(root: &std::path::Path) -> (DomainRepository, RunnerCapability) {
    let mut db = DomainRepository::open(&root.join("state")).unwrap();
    db.register(&registration()).unwrap();
    let pool = resource("pool", "seat", 100);
    db.put_resource(&pool).unwrap();
    let proof = proof(&request("request", "Worker", &pool, 10));
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
    db.observe_matrix_transport(
        &hagency_core::replies::MatrixTransportObservation {
            engagement_id: e.id.clone(),
            registration_generation: 1,
            generation: 1,
            sender_mxid: "@worker:example.test".into(),
            device_id: "DEVICE".into(),
        },
        now(),
    )
    .unwrap();
    db.observe_matrix_room(
        &hagency_core::replies::MatrixRoomObservation {
            engagement_id: e.id.clone(),
            registration_generation: 1,
            transport_generation: 1,
            room_id: "!project:example.test".into(),
            generation: 1,
            privacy: hagency_core::replies::RoomPrivacy::Group {},
            joined: std::collections::BTreeSet::from([
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
            engagement_id: e.id,
            room_id: "!project:example.test".into(),
            thread_root: None,
        },
        now(),
    )
    .unwrap();
    db.register_workspace("work").unwrap();
    db.create_canonical_task("task", "session", "Receipt loss", now())
        .unwrap();
    db.enqueue_dispatch(&DispatchInput {
        id: "dispatch".into(),
        session_id: "session".into(),
        task_id: Some("task".into()),
        resources: vec![hagency_core::tasks::ResourceLease {
            id: "work".into(),
            exclusive: true,
        }],
        payload: json!({"instruction":"offline"}),
    })
    .unwrap();
    let cap = db
        .claim_dispatch("host", now(), 60_000, 60_000, 1)
        .unwrap()
        .unwrap();
    db.start_dispatch(&cap, now()).unwrap();
    (db, cap)
}

use hagency_core::file_delivery::*;
fn request_file(call: &str) -> FileDeliveryRequest {
    FileDeliveryRequest {
        call_id: call.into(),
        request_digest: "1".repeat(64),
        filename: "result.txt".into(),
        caption: None,
    }
}
fn capture() -> CapturedFile {
    CapturedFile {
        size: 12,
        sha256: "2".repeat(64),
    }
}
fn stage() -> StageCommitment {
    StageCommitment {
        namespace_digest: "3".repeat(64),
        operation_id: "stage".into(),
        receipt_digest: "4".repeat(64),
        len: 12,
    }
}
async fn ready(
    store: &DomainStore,
    cap: &RunnerCapability,
) -> (crate::FileDeliveryIdentity, crate::FilePublicationClaim) {
    let a = store
        .reserve_file_delivery(cap.clone(), request_file("publication"))
        .await
        .unwrap();
    store
        .bind_file_delivery_stage(
            cap.clone(),
            a.identity.clone(),
            Arc::new(a.upload.preparation.unwrap()),
            capture(),
            stage(),
        )
        .await
        .unwrap();
    store
        .observe_upload_staged(
            a.upload.identity.clone(),
            stage(),
            UploadStageObservation::FileAndDirectorySynced,
        )
        .await
        .unwrap();
    let upload = store
        .claim_upload(cap.clone(), a.upload.identity.clone(), 60000)
        .await
        .unwrap()
        .unwrap();
    drop(
        store
            .begin_upload(cap.clone(), upload.clone())
            .await
            .unwrap(),
    );
    store
        .record_upload_acceptance(
            a.upload.identity,
            upload.fence(),
            stage(),
            UploadAcceptance {
                receipt_id: "private_upload".into(),
                receipt_digest: "5".repeat(64),
            },
        )
        .await
        .unwrap();
    let (one, two) = tokio::join!(
        store.claim_file_publication(cap.clone(), a.identity.clone(), 60000),
        store.claim_file_publication(cap.clone(), a.identity.clone(), 60000)
    );
    let mut claims = [one.unwrap(), two.unwrap()];
    assert_eq!(claims.iter().flatten().count(), 1);
    (
        a.identity,
        claims.iter_mut().find_map(Option::take).unwrap(),
    )
}
#[tokio::test]
async fn native_file_delivery_worker_lost_and_queued() {
    let root = tempfile::tempdir().unwrap();
    let (db, cap) = fixture(root.path());
    let store = DomainStore::start(db, 8).unwrap();
    let (done, wait) = oneshot::channel();
    let original = cap.clone();
    store
        .tx
        .try_send(Job::Run {
            operation: Box::new(move |db| {
                let result = db
                    .upload_transaction(writer_time, |tx, n| {
                        crate::domain::file_delivery::reserve(
                            tx,
                            &original,
                            &request_file("lost"),
                            n,
                        )
                    })
                    .unwrap();
                assert!(result.upload.preparation.is_some());
                drop(result);
                let _ = done.send(());
            }),
            _bytes: store.bytes.clone().try_acquire_many_owned(2048).unwrap(),
        })
        .unwrap_or_else(|_| panic!("fixture admission"));
    tokio::time::timeout(Duration::from_secs(2), wait)
        .await
        .unwrap()
        .unwrap();
    assert!(
        store
            .reserve_file_delivery(cap.clone(), request_file("lost"))
            .await
            .unwrap()
            .upload
            .preparation
            .is_none()
    );
    let (id, claim) = ready(&store, &cap).await;
    let (a, b) = tokio::join!(
        store.begin_file_publication(cap.clone(), claim.clone()),
        store.begin_file_publication(cap.clone(), claim.clone())
    );
    assert_eq!([a.is_ok(), b.is_ok()].into_iter().filter(|v| *v).count(), 1);
    drop(a);
    drop(b);
    assert_eq!(
        store
            .inspect_file_delivery(cap.clone(), id.id().into())
            .await
            .unwrap()
            .event,
        FileEventState::WritePossible
    );
    assert!(
        store
            .begin_file_publication(cap.clone(), claim)
            .await
            .is_err()
    );
    assert!(
        store
            .claim_file_publication(cap.clone(), id.clone(), 60000)
            .await
            .unwrap()
            .is_none()
    );
    store.shutdown().await.unwrap();
    let db = DomainRepository::open(&root.path().join("state")).unwrap();
    assert_eq!(
        db.inspect_file_delivery(&cap, id.id()).unwrap().status,
        FileDeliveryStatus::OutcomeUnknown
    );
    drop(db);
    for lock in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (db, cap) = fixture(root.path());
        let store = DomainStore::start(db, 8).unwrap();
        let (id, claim) = ready(&store, &cap).await;
        let sql = rusqlite::Connection::open(root.path().join("state/domain.sqlite3")).unwrap();
        let mut release = None;
        if lock {
            sql.execute_batch("BEGIN IMMEDIATE;").unwrap();
        } else {
            let (entered, reached) = oneshot::channel();
            let (resume, paused) = std::sync::mpsc::channel();
            store
                .tx
                .try_send(Job::Run {
                    operation: Box::new(move |_| {
                        let _ = entered.send(());
                        paused.recv_timeout(Duration::from_secs(2)).unwrap();
                    }),
                    _bytes: store.bytes.clone().try_acquire_owned().unwrap(),
                })
                .unwrap_or_else(|_| panic!("fixture admission"));
            reached.await.unwrap();
            release = Some(resume);
        }
        sql.execute(
            "UPDATE runner_dispatches SET lease_until=?1 WHERE id='dispatch'",
            [now() + 30],
        )
        .unwrap();
        let begun = tokio::spawn({
            let store = store.clone();
            let cap = cap.clone();
            async move { store.begin_file_publication(cap, claim).await }
        });
        if !lock {
            tokio::time::timeout(Duration::from_secs(1), async {
                while store.tx.capacity() == 8 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        if lock {
            sql.execute_batch("COMMIT;").unwrap();
        } else {
            release.unwrap().send(()).unwrap();
        }
        assert!(
            matches!(begun.await.unwrap(), Err(Error::RunnerAuthority)),
            "lock={lock}"
        );
        assert_eq!(
            store
                .inspect_file_delivery(cap, id.id().into())
                .await
                .unwrap()
                .event,
            FileEventState::Claimed
        );
        store.shutdown().await.unwrap();
    }
}
