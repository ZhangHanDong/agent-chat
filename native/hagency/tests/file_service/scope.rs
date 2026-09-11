use super::{admission_tests::*, *};
use hagency_core::{file_delivery::*, replies::MatrixRoomInvalidation, uploads::*};

#[tokio::test]
async fn native_file_service_authority_queue_retirement_and_lower_limit() {
    let mut h = Harness::new(8).await;
    if !h.initialize().await {
        h.fake.no_request().await;
        h.close().await;
        return;
    }
    let handle = h.owner.handle();
    let mut foreign = h.cap.clone();
    foreign.secret = "f".repeat(64);
    assert_eq!(
        handle
            .submit(foreign, input("foreign"))
            .unwrap()
            .wait()
            .await,
        Err(FileError::Unauthorized)
    );
    h.empty().await;
    let mut escape = input("escape");
    escape.path = "../secret".into();
    assert!(matches!(
        handle.submit(h.cap.clone(), escape),
        Err(FileError::Invalid)
    ));
    assert_eq!(h.count(), 0);
    std::fs::write(h.f.root.path().join("work/missing.bin"), b"123456789").unwrap();
    let oversized = handle
        .submit(h.cap.clone(), input("lower_limit"))
        .unwrap()
        .wait()
        .await
        .unwrap();
    h.empty().await;
    let receipt =
        h.f.store
            .inspect_file_delivery(h.cap.clone(), oversized.delivery_id)
            .await
            .unwrap();
    assert_eq!(receipt.error_code, Some(FileDeliveryFailure::SourceRefused));
    assert!(receipt.captured.is_none());
    std::fs::write(h.f.root.path().join("work/missing.bin"), b"1234").unwrap();
    let gate = h.gate();
    let queued = handle
        .submit(h.cap.clone(), input("queued"))
        .unwrap()
        .wait()
        .await
        .unwrap();
    gate.entered().await;
    // Authenticated host negative evidence, while the actual source worker is
    // queued at its boundary. No SQL availability or expiry setter is used.
    h.f.store
        .invalidate_matrix_room(MatrixRoomInvalidation {
            engagement_id: h.f.identity.transport.engagement_id.clone(),
            registration_generation: 1,
            transport_generation: 1,
            room_id: "!direct:example.test".into(),
            generation: 2,
            reason: "fixture authenticated owner departure".into(),
        })
        .await
        .unwrap();
    gate.release();
    h.empty().await;
    let historical = handle
        .inspect(h.cap.clone(), queued.delivery_id.clone())
        .await
        .unwrap();
    assert_eq!(historical.status, FileStatus::Failed);
    let receipt =
        h.f.store
            .inspect_file_delivery(h.cap.clone(), queued.delivery_id)
            .await
            .unwrap();
    assert!(receipt.captured.is_none());
    assert_eq!(receipt.stage, UploadStageState::Unbound);
    assert_eq!(
        handle
            .submit(h.cap.clone(), input("after_retirement"))
            .unwrap()
            .wait()
            .await,
        Err(FileError::Unauthorized)
    );
    h.empty().await;
    assert_eq!(h.count(), 2);
    h.fake.no_request().await;
    h.close().await;
}

#[tokio::test]
async fn native_file_service_authority_expired_attempt() {
    let mut h = Harness::new(128).await;
    if !h.initialize().await {
        h.fake.no_request().await;
        h.close().await;
        return;
    }
    let handle = h.owner.handle();
    let gate = h.gate();
    let queued = handle
        .submit(h.cap.clone(), input("expired"))
        .unwrap()
        .wait()
        .await
        .unwrap();
    gate.entered().await;
    // The actual host reconciliation command observes a time beyond the issued
    // lease; it performs the real expired-attempt transition. This is not a
    // wall-clock timing claim or a SQL mutation of authority rows.
    h.f.store
        .reconcile_dispatches(now() + 120_000)
        .await
        .unwrap();
    gate.release();
    h.empty().await;
    let receipt =
        h.f.store
            .inspect_file_delivery(h.cap.clone(), queued.delivery_id.clone())
            .await
            .unwrap();
    assert!(receipt.captured.is_none());
    assert_eq!(
        handle
            .inspect(h.cap.clone(), queued.delivery_id)
            .await
            .unwrap()
            .status,
        FileStatus::Failed
    );
    assert_eq!(
        handle
            .submit(h.cap.clone(), input("expired_new"))
            .unwrap()
            .wait()
            .await,
        Err(FileError::Unauthorized)
    );
    h.empty().await;
    h.fake.no_request().await;
    h.close().await;
}

#[test]
fn native_file_service_protocol_missing_failure_stays_unknown() {
    let receipt = FileDeliveryReceipt {
        id: "file_receipt".into(),
        filename: "safe.bin".into(),
        captured: None,
        stage: UploadStageState::Unbound,
        upload: UploadState::Pending,
        event: FileEventState::Pending,
        status: FileDeliveryStatus::Failed,
        cancel_requested: false,
        error_code: None,
        event_id: None,
        replayed: false,
    };
    let projected = FileView::from_receipt(receipt.clone(), false);
    assert_eq!(projected.status, FileStatus::OutcomeUnknown);
    assert_eq!(projected.error_code.as_deref(), Some("outcome_unknown"));
    projected.validate().unwrap();
    let mut contradictory = receipt;
    contradictory.status = FileDeliveryStatus::Delivered;
    contradictory.error_code = Some(FileDeliveryFailure::SourceRefused);
    assert_eq!(
        FileView::from_receipt(contradictory, false).status,
        FileStatus::OutcomeUnknown
    );
}
