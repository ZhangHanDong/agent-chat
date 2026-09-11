use super::*;
use hagency_core::{approvals::*, replies::*};
use hagency_execution::{ApprovalHost, ApprovalRequests};
use std::collections::BTreeSet;

pub(super) fn bindings(db: &mut DomainRepository, engagement: &str) {
    db.observe_matrix_transport(
        &MatrixTransportObservation {
            engagement_id: engagement.into(),
            registration_generation: 1,
            generation: 1,
            sender_mxid: "@worker:example.test".into(),
            device_id: "WORKER".into(),
        },
        now(),
    )
    .unwrap();
    db.observe_matrix_room(
        &MatrixRoomObservation {
            engagement_id: engagement.into(),
            registration_generation: 1,
            transport_generation: 1,
            generation: 1,
            room_id: "!project:example.test".into(),
            privacy: RoomPrivacy::Group {},
            joined: BTreeSet::from(["@worker:example.test".into(), "@owner:example.test".into()]),
            invite_only: true,
            encrypted: false,
        },
        now(),
    )
    .unwrap();
    db.observe_approval_room(
        &ApprovalRoomObservation {
            engagement_id: engagement.into(),
            registration_generation: 1,
            generation: 1,
            room_id: "!private:example.test".into(),
            device_id: "BOT".into(),
            joined: BTreeSet::from([
                "@owner:example.test".into(),
                "@approval:example.test".into(),
            ]),
            invite_only: true,
            encrypted: true,
            available: true,
        },
        now(),
    )
    .unwrap();
}
pub(super) fn policy() -> ApprovalHost {
    ApprovalHost::new(4, 2, 20_000, 1500).unwrap()
}
pub(super) fn operation(
    f: &Fixture,
    mode: &str,
    policy: ApprovalHost,
) -> (Operation, ApprovalRequests) {
    let host = f.host(mode, "work", false).with_approvals(policy).unwrap();
    let mut operation = Operation::start(f.domain.clone(), f.cap.clone(), host, limits()).unwrap();
    let notices = operation.take_approval_requests().unwrap();
    assert!(operation.take_approval_requests().is_none());
    (operation, notices)
}
pub(super) async fn notice(notices: &mut ApprovalRequests) -> hagency_execution::ApprovalNotice {
    tokio::time::timeout(Duration::from_secs(6), notices.recv())
        .await
        .expect("actual committed request notice deadline")
        .expect("notice channel closed")
}
pub(super) async fn choose(f: &Fixture, id: &str, choice: ApprovalChoice) {
    let card = f.domain.private_approval(id.into()).await.unwrap();
    f.domain
        .observe_owner_verdict(OwnerVerdictObservation {
            request_id: id.into(),
            request_digest: card.digest,
            binding_generation: card.binding_generation,
            server_name: "example.test".into(),
            room_id: card.room_id,
            sender_mxid: card.owner_mxid,
            event_id: format!("${id}"),
            encrypted: true,
            choice,
        })
        .await
        .unwrap();
}
pub(super) fn responses(f: &Fixture) -> Vec<serde_json::Value> {
    fs::read_to_string(f.work.join("owned-dispatch.requests"))
        .unwrap()
        .lines()
        .map(|v| serde_json::from_str::<serde_json::Value>(v).unwrap())
        .filter(|v| v.get("result").is_some())
        .collect()
}
pub(super) fn unconfirmed(f: &Fixture) {
    assert_eq!(
        f.count("SELECT COUNT(*) FROM owner_approvals WHERE state='applied'"),
        0
    );
    assert_eq!(
        f.count("SELECT COUNT(*) FROM approval_responses WHERE write_accepted=1"),
        responses(f).len() as u64
    );
}
pub(super) async fn marker(f: &Fixture, extension: &str) {
    let until = tokio::time::Instant::now() + Duration::from_secs(5);
    while !f.work.join(format!("owned-dispatch.{extension}")).exists() {
        assert!(
            tokio::time::Instant::now() < until,
            "missing actual fixture marker {extension}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
