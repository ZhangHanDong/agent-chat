use super::*;
use crate::CancellationToken;
use crate::collector::{
    Collector, fixtures as common,
    observation::{Phase, SdkCommand, Trace, observed},
};

#[tokio::test]
async fn native_matrix_operation_observation_queued_owner() {
    let root = tempfile::tempdir().unwrap();
    let config = super::tests::config(root.path());
    let owner = Owner::open(&config).await.unwrap();
    let sql = rusqlite::Connection::open(config.root.join(DATABASES[0])).unwrap();
    sql.execute_batch("BEGIN IMMEDIATE").unwrap();
    let first = Trace::new("held original sync", Some("caller dropped"), None);
    let mut held = first.hold(Phase::Started);
    let mut write = Box::pin(observed(
        first.clone(),
        owner.sync(common::sync("retained-original")),
    ));
    tokio::select! {
        _ = held.reached() => {},
        result = &mut write => panic!("original write escaped held owner: {result:?}"),
    }
    first.wait(Phase::Queued).await;
    drop(write);
    let second = Trace::new("queued original cursor", None, None);
    let mut read = Box::pin(observed(second.clone(), owner.cursor()));
    tokio::select! {
        _ = second.wait(Phase::Queued) => {},
        result = &mut read => panic!("queued read escaped held owner: {result:?}"),
    }
    assert!(!second.has(Phase::Started));
    drop(read);
    assert!(matches!(Owner::open(&config).await, Err(Error::Busy)));
    held.release();
    sql.execute_batch("COMMIT").unwrap();
    drop(sql);
    first.wait(Phase::Returned).await;
    second.wait(Phase::Returned).await;
    for (trace, command, label) in [
        (&first, SdkCommand::Sync, "held original sync"),
        (&second, SdkCommand::Cursor, "queued original cursor"),
    ] {
        let snapshot = trace.snapshot();
        assert_eq!(snapshot.callsite, label);
        assert_eq!(snapshot.batch, None);
        assert!(
            snapshot.primary.is_none()
                && snapshot.fence.is_none()
                && snapshot.sdk_failure.is_none()
        );
        assert!(!trace.has(Phase::CallerReturned));
        assert!(!trace.has(Phase::OperationReturned));
        let events = snapshot.events.iter().flatten().collect::<Vec<_>>();
        assert_eq!(events.len(), 3);
        assert!(
            events
                .windows(2)
                .all(|pair| pair[0].elapsed_us <= pair[1].elapsed_us)
        );
        assert!(events.iter().all(|e| e.command == Some(command)
            && e.sequence == 1
            && e.index.is_none()
            && e.error.is_none()));
        assert!(trace.has(Phase::Started));
    }
    assert_eq!(first.snapshot().variant, Some("caller dropped"));
    assert_eq!(second.snapshot().variant, None);
    assert_eq!(
        owner.cursor().await.unwrap().as_deref(),
        Some("retained-original")
    );
    owner.close().await.unwrap();
    let owner = Owner::open(&config).await.unwrap();
    assert_eq!(
        owner.cursor().await.unwrap().as_deref(),
        Some("retained-original")
    );
    owner.close().await.unwrap();
}

#[tokio::test]
async fn native_matrix_operation_observation_owner_lifecycle() {
    let root = tempfile::tempdir().unwrap();
    let config = super::tests::config(root.path());
    let opening = Trace::new("held original open", None, None);
    let mut held = opening.hold(Phase::Prepared);
    let mut open = Box::pin(observed(opening.clone(), Owner::open(&config)));
    tokio::select! {
        _ = held.reached() => {},
        _ = &mut open => panic!("original open escaped held owner"),
    }
    assert!(opening.has(Phase::PrepareStarted));
    assert!(!opening.has(Phase::SdkOpenStarted));
    let rejected = Trace::new("held owner's competing open", None, None);
    assert!(matches!(
        observed(rejected.clone(), Owner::open(&config)).await,
        Err(Error::Busy)
    ));
    assert!(rejected.has(Phase::PrepareFailed));
    assert!(!rejected.has(Phase::SdkOpenStarted));
    assert!(!rejected.has(Phase::SdkOpenReturned));
    held.release();
    let owner = open.await.unwrap();
    for phase in [
        Phase::StateStoreOpen,
        Phase::CryptoStoreOpen,
        Phase::Activate,
        Phase::JournalLoad,
        Phase::SdkOpenReturned,
        Phase::OpenCallerReturned,
    ] {
        assert!(opening.has(phase), "missing original open phase {phase:?}");
    }
    let (send, reply) = oneshot::channel();
    owner
        .tx
        .try_send(Command::CloseFault(send))
        .unwrap_or_else(|_| panic!("fixture close fault queue"));
    reply.await.unwrap();
    let closing = Trace::new("held original close", None, None);
    let mut held = closing.hold(Phase::RuntimeDropStarted);
    let mut close = Box::pin(observed(closing.clone(), owner.close()));
    tokio::select! {
        _ = held.reached() => {},
        result = &mut close => panic!("original close escaped held owner: {result:?}"),
    }
    assert!(closing.has(Phase::CloseStoresReturned));
    assert!(!closing.has(Phase::LockDropped));
    assert!(!closing.has(Phase::CloseAcknowledgement));
    assert!(matches!(Owner::open(&config).await, Err(Error::Busy)));
    held.release();
    assert_eq!(close.await, Err(Error::OutcomeUnknown));
    let snapshot = closing.snapshot();
    assert_eq!(
        snapshot.sdk_failure.unwrap().error,
        Some(Error::OutcomeUnknown)
    );
    let events = snapshot.events.iter().flatten().collect::<Vec<_>>();
    let position = |phase| events.iter().position(|e| e.phase == phase).unwrap();
    assert!(position(Phase::CloseStoresReturned) < position(Phase::RuntimeDropped));
    assert!(position(Phase::RuntimeDropped) < position(Phase::LockDropped));
    assert!(position(Phase::LockDropped) < position(Phase::CloseAcknowledgement));
    assert!(position(Phase::CloseAcknowledgement) < position(Phase::CallerReturned));
    assert_eq!(
        events[position(Phase::CallerReturned)].error,
        Some(Error::OutcomeUnknown)
    );
    let owner = Owner::open(&config).await.unwrap();
    owner.close().await.unwrap();
}

#[tokio::test]
async fn native_matrix_operation_observation_primary_fence() {
    let f = common::Fixture::new();
    let mut fake = common::Fake::start(false).await;
    f.store
        .observe_matrix_transport(f.identity.transport.clone())
        .await
        .unwrap();
    let c = Collector::new(f.config(&fake.endpoint), f.store.clone()).unwrap();
    let trace = Trace::new("original refusal with failed fence", None, None);
    let cancel = CancellationToken::new();
    let result = observed(trace.clone(), async {
        let (result, ()) = common::scripted(c.collect(&cancel), async {
            let request = fake.next().await;
            // The actual collector already read its expected transport before whoami.
            common::shutdown_domain(&f.store, "primary-fence writer shutdown").await;
            let mut who = common::who();
            who["device_id"] = serde_json::json!("WRONG_DEVICE");
            request.json(200, who);
        })
        .await;
        result
    })
    .await;
    assert_eq!(result, Err(Error::OutcomeUnknown));
    let snapshot = trace.snapshot();
    assert_eq!(snapshot.primary.unwrap().error, Some(Error::Identity));
    assert_eq!(snapshot.fence.unwrap().error, Some(Error::Domain));
    assert!(trace.has(Phase::Whoami));
    assert!(!trace.has(Phase::OpenOwner));
    assert_eq!(c.close().await, Err(Error::Domain));
    fake.close().await;
}
