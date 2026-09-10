#![allow(dead_code)] // Shared by separate focused integration test executables.
use hagency_core::{authority::*, project::Resource};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub fn resource(preset: &str, seat: &str, tokens: u64) -> Resource {
    serde_json::from_value(
        json!({"presetId":preset,"seatId":seat,"framework":"codex","model":"fixture",
        "roles":["coding"],"ceiling":{"tokens":tokens,"period":"monthly"}}),
    )
    .unwrap()
}
pub fn registration() -> Registration {
    let fleet = format!("hf_{}", "a".repeat(32));
    Registration {
        fleet_id: fleet.clone(),
        generation: 1,
        server_name: "example.test".into(),
        reception_room_id: "!reception:example.test".into(),
        representative_mxid: format!("@{fleet}_representative:example.test"),
        approval_bot_mxid: "@approval:example.test".into(),
    }
}
pub fn request(id: &str, name: &str, resource: &Resource, tokens: u64) -> ProjectRequest {
    serde_json::from_value(json!({"v":1,"fleetId":registration().fleet_id,"requestId":id,
        "requesterMxid":"@owner:example.test","sourceRoomId":"!reception:example.test","targetProjectId":"project_one","targetRoomId":"!project:example.test",
        "ownerMxid":"@owner:example.test","ownerDmRoomId":"!private:example.test","role":"coding","requestedTokens":tokens,"ratePerDay":null,"authVersion":1,
        "sourceEventId":format!("${id}"),"agentDefinition":{"name":name,"resourceId":resource.id()}})).unwrap()
}
fn room(id: &str, members: Vec<String>) -> RoomObservation {
    RoomObservation {
        room_id: id.into(),
        joined: BTreeSet::from_iter(members),
        invite_only: true,
        encryption: None,
        powers: BTreeMap::new(),
        default_power: 0,
        invite_power: 0,
        binding: None,
        name: None,
    }
}
pub fn observation(request: &ProjectRequest) -> RequestObservation {
    let reg = registration();
    let reception = room(
        &request.source_room_id,
        vec![
            request.requester_mxid.clone(),
            reg.representative_mxid.clone(),
        ],
    );
    let mut project = room(
        &request.target_room_id,
        vec![
            request.requester_mxid.clone(),
            request.owner_mxid.clone(),
            reg.representative_mxid,
        ],
    );
    project.powers.insert(request.owner_mxid.clone(), 100);
    project.name = Some("实际项目名称".into());
    project.binding = Some(
        json!({"v":1,"fleetId":reg.fleet_id,"purpose":"project","projectId":request.target_project_id,"ownerMxid":request.owner_mxid,"authVersion":1}),
    );
    let mut owner_room = room(
        &request.owner_dm_room_id,
        vec![request.owner_mxid.clone(), reg.approval_bot_mxid],
    );
    owner_room.encryption = Some("m.megolm.v1.aes-sha2".into());
    let mut content = serde_json::to_value(request).unwrap();
    content.as_object_mut().unwrap().remove("ownerDmRoomId");
    content.as_object_mut().unwrap().remove("sourceEventId");
    RequestObservation {
        registration_generation: 1,
        observed_at_ms: 1000,
        source: SourceObservation {
            event_id: request.source_event_id.clone(),
            room_id: request.source_room_id.clone(),
            sender: request.requester_mxid.clone(),
            event_type: "com.hagency.engagement.request.v1".into(),
            content,
        },
        reception,
        project,
        owner_room,
    }
}
pub fn proof(request: &ProjectRequest) -> VerifiedRequest {
    verify_request(&registration(), request.clone(), observation(request)).unwrap()
}
pub fn value<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap()
}
