use super::Sdk;
use crate::{
    Error,
    outgoing::state::{self, Attempt, Command, Phase, View, Write},
};
use matrix_sdk_crypto::{CollectStrategy, EncryptionSettings, UserIdentity};
use ruma::api::IncomingResponse;
use ruma::{
    OwnedUserId,
    api::client::{keys::get_keys, to_device::send_event_to_device},
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

impl Sdk {
    pub(super) async fn outgoing(&mut self, command: Command) -> Result<View, Error> {
        if self.outgoing_poisoned {
            return Err(Error::OutcomeUnknown);
        }
        match command {
            Command::Read => {}
            Command::Start(mut attempt) => {
                if self.journal.outgoing.is_some() {
                    return Err(Error::OutcomeUnknown);
                }
                if self.journal.outgoing_receipts.len() >= state::MAX_RECEIPTS {
                    return Err(Error::Capacity);
                }
                if self.journal.outgoing_receipts.iter().any(|r| {
                    r.kind == attempt.kind && r.id == attempt.id && r.fence == attempt.fence
                }) {
                    return Err(Error::Conflict);
                }
                attempt.identity = self.identity.clone();
                let guard = self.client.olm_machine().await;
                let machine = guard.as_ref().ok_or(Error::Storage)?;
                attempt.validate(
                    &self.identity,
                    machine.user_id().as_str(),
                    machine.device_id().as_str(),
                )?;
                drop(guard);
                self.journal.outgoing = Some(*attempt);
                self.persist_outgoing().await?;
            }
            Command::Begun => {
                let attempt = self.journal.outgoing.as_mut().ok_or(Error::Storage)?;
                if attempt.phase != Phase::BeforeBegin {
                    return Err(Error::OutcomeUnknown);
                }
                if !attempt.route.encrypted {
                    attempt.writes.push(Write::new(
                        "m.room.message".into(),
                        attempt.transaction_id.clone(),
                        attempt.content.clone(),
                        true,
                    )?);
                }
                attempt.phase = Phase::Ready;
                self.persist_outgoing().await?;
            }
            Command::Query => {
                let attempt = self.journal.outgoing.as_ref().ok_or(Error::Storage)?;
                if attempt.phase != Phase::Ready
                    || !attempt.route.encrypted
                    || !attempt.writes.is_empty()
                {
                    return Err(Error::OutcomeUnknown);
                }
                let users = users(attempt)?;
                let guard = self.client.olm_machine().await;
                let machine = guard.as_ref().ok_or(Error::Storage)?;
                let (id, _) = machine.query_keys_for_users(users.iter().map(|u| u.as_ref()));
                let body = json!({"device_keys": users.iter().map(|u|(u.to_string(),json!([]))).collect::<serde_json::Map<_,_>>()});
                drop(guard);
                let attempt = self.journal.outgoing.as_mut().ok_or(Error::Storage)?;
                attempt.query_id = Some(id.to_string());
                attempt.query_body = Some(state::encode(&body, state::MAX_QUERY)?);
                attempt.phase = Phase::QueryPrepared;
                self.persist_outgoing().await?;
            }
            Command::Encrypt(response) => {
                state::encode(&response, state::MAX_QUERY)?;
                let attempt = self.journal.outgoing.as_mut().ok_or(Error::Storage)?;
                if attempt.phase != Phase::QueryPrepared {
                    return Err(Error::OutcomeUnknown);
                }
                attempt.query_response = Some(response);
                attempt.phase = Phase::CryptoApplying;
                self.persist_outgoing().await?;
                let result = self.encrypt_outgoing().await;
                if let Err(error) = result {
                    if error == Error::Unsupported
                        || error == Error::Capacity
                        || error == Error::Wire
                    {
                        self.journal.outgoing.as_mut().ok_or(Error::Storage)?.phase =
                            Phase::Quarantined;
                        self.persist_outgoing().await?;
                    }
                    return Err(error);
                }
                self.persist_outgoing().await?;
            }
            Command::Possible(index) => {
                let attempt = self.journal.outgoing.as_mut().ok_or(Error::Storage)?;
                if attempt.phase != Phase::Ready
                    || attempt.index != index
                    || index >= attempt.writes.len()
                {
                    return Err(Error::OutcomeUnknown);
                }
                attempt.phase = Phase::WritePossible;
                self.persist_outgoing().await?;
            }
            Command::Accept(index, response) => {
                state::encode(&response, 4096)?;
                let attempt = self.journal.outgoing.as_mut().ok_or(Error::Storage)?;
                if attempt.phase != Phase::WritePossible || attempt.index != index {
                    return Err(Error::OutcomeUnknown);
                }
                let write = attempt.writes.get_mut(index).ok_or(Error::Storage)?;
                if write.room {
                    let event = response
                        .get("event_id")
                        .and_then(Value::as_str)
                        .ok_or(Error::Wire)?;
                    hagency_core::replies::matrix_event(event).map_err(|_| Error::Wire)?;
                    if response.as_object().is_none_or(|o| o.len() != 1) {
                        return Err(Error::Wire);
                    }
                } else if response.as_object().is_none_or(|o| !o.is_empty()) {
                    return Err(Error::Wire);
                }
                write.response = Some(response);
                attempt.phase = if write.room {
                    Phase::Complete
                } else {
                    Phase::ResponseStored
                };
                self.persist_outgoing().await?;
                if self.journal.outgoing.as_ref().ok_or(Error::Storage)?.phase
                    == Phase::ResponseStored
                {
                    let attempt = self.journal.outgoing.as_ref().ok_or(Error::Storage)?;
                    let id = attempt.writes[index].transaction_id.as_str();
                    let guard = self.client.olm_machine().await;
                    let machine = guard.as_ref().ok_or(Error::Storage)?;
                    machine
                        .mark_request_as_sent(id.into(), &send_event_to_device::v3::Response::new())
                        .await
                        .map_err(|_| Error::OutcomeUnknown)?;
                    drop(guard);
                    let attempt = self.journal.outgoing.as_mut().ok_or(Error::Storage)?;
                    attempt.index += 1;
                    attempt.phase = Phase::Ready;
                    self.persist_outgoing().await?;
                }
            }
            Command::Settle => {
                let receipt = self
                    .journal
                    .outgoing
                    .as_ref()
                    .ok_or(Error::Storage)?
                    .receipt()?;
                if self.journal.outgoing_receipts.len() >= state::MAX_RECEIPTS {
                    return Err(Error::Capacity);
                }
                self.journal.outgoing_receipts.push(receipt);
                self.journal.outgoing = None;
                self.persist_outgoing().await?;
            }
        }
        Ok(View {
            attempt: self.journal.outgoing.clone(),
            receipts: self.journal.outgoing_receipts.clone(),
        })
    }
    async fn persist_outgoing(&mut self) -> Result<(), Error> {
        if let Some(attempt) = &self.journal.outgoing {
            let guard = self.client.olm_machine().await;
            let machine = guard.as_ref().ok_or(Error::Storage)?;
            if let Err(error) = attempt.validate(
                &self.identity,
                machine.user_id().as_str(),
                machine.device_id().as_str(),
            ) {
                self.outgoing_poisoned = true;
                return Err(error);
            }
        }
        if let Err(error) = self.persist().await {
            self.outgoing_poisoned = true;
            return Err(error);
        }
        Ok(())
    }
    async fn encrypt_outgoing(&mut self) -> Result<(), Error> {
        let attempt = self.journal.outgoing.as_ref().ok_or(Error::Storage)?;
        let response = attempt.query_response.as_ref().ok_or(Error::Storage)?;
        let users = users(attempt)?;
        validate_keys_shape(attempt, response)?;
        let query = get_keys::v3::Response::try_from_http_response(http::Response::new(
            response.to_string().into_bytes(),
        ))
        .map_err(|_| Error::Wire)?;
        let guard = self.client.olm_machine().await;
        let machine = guard.as_ref().ok_or(Error::Storage)?;
        let own = machine.identity_keys();
        let own_keys = &response["device_keys"][machine.user_id().as_str()]
            [machine.device_id().as_str()]["keys"];
        if own_keys
            .get(format!("curve25519:{}", machine.device_id()))
            .and_then(Value::as_str)
            != Some(own.curve25519.to_base64().as_str())
            || own_keys
                .get(format!("ed25519:{}", machine.device_id()))
                .and_then(Value::as_str)
                != Some(own.ed25519.to_base64().as_str())
        {
            return Err(Error::Identity);
        }
        machine
            .mark_request_as_sent(
                attempt.query_id.as_deref().ok_or(Error::Storage)?.into(),
                &query,
            )
            .await
            .map_err(|_| Error::OutcomeUnknown)?;
        let mut recipients = BTreeSet::new();
        for user in &users {
            let identity = machine
                .get_identity(user, None)
                .await
                .map_err(|_| Error::OutcomeUnknown)?
                .ok_or(Error::Recipients)?;
            if !identity.is_verified() {
                return Err(Error::Recipients);
            }
            // A malformed fresh entry may be ignored by the SDK while a cached
            // verified identity survives. Require the supplied authority fields
            // to be exactly the identity the SDK accepted, not just present.
            let (master, signing) = match &identity {
                UserIdentity::Own(identity) => (
                    serde_json::to_value(identity.master_key().as_ref()),
                    serde_json::to_value(identity.self_signing_key().as_ref()),
                ),
                UserIdentity::Other(identity) => (
                    serde_json::to_value(identity.master_key().as_ref()),
                    serde_json::to_value(identity.self_signing_key().as_ref()),
                ),
            };
            let master = master.map_err(|_| Error::Storage)?;
            let signing = signing.map_err(|_| Error::Storage)?;
            for (fresh, accepted) in [
                (&response["master_keys"][user.as_str()], &master),
                (&response["self_signing_keys"][user.as_str()], &signing),
            ] {
                if !same_fields(fresh, accepted, &["user_id", "usage", "keys", "signatures"]) {
                    return Err(Error::Recipients);
                }
            }
            let devices = machine
                .get_user_devices(user, None)
                .await
                .map_err(|_| Error::OutcomeUnknown)?;
            let fresh = response["device_keys"][user.as_str()]
                .as_object()
                .ok_or(Error::Wire)?;
            let mut seen = BTreeSet::new();
            for device in devices.devices() {
                let id = device.device_id().as_str();
                if !device.is_verified() || !device.is_cross_signed_by_owner() {
                    return Err(Error::Recipients);
                }
                let raw = fresh.get(id).ok_or(Error::Recipients)?;
                let accepted =
                    serde_json::to_value(device.as_device_keys()).map_err(|_| Error::Storage)?;
                if !same_fields(
                    raw,
                    &accepted,
                    &["user_id", "device_id", "algorithms", "keys", "signatures"],
                ) || raw["user_id"].as_str() != Some(user.as_str())
                    || raw["device_id"].as_str() != Some(id)
                {
                    return Err(Error::Recipients);
                }
                seen.insert(id.to_string());
                if user == machine.user_id() && device.device_id() == machine.device_id() {
                    let own = machine.identity_keys();
                    if device.curve25519_key() != Some(own.curve25519)
                        || device.ed25519_key() != Some(own.ed25519)
                    {
                        return Err(Error::Identity);
                    }
                } else {
                    recipients.insert((user.to_string(), id.to_string()));
                }
            }
            if seen.len() != fresh.len() || seen.is_empty() {
                return Err(Error::Recipients);
            }
        }
        if response["device_keys"][machine.user_id().as_str()]
            .get(machine.device_id().as_str())
            .is_none()
        {
            return Err(Error::Identity);
        }
        if machine
            .get_missing_sessions(users.iter().map(|u| u.as_ref()))
            .await
            .map_err(|_| Error::OutcomeUnknown)?
            .is_some()
        {
            return Err(Error::Unsupported);
        }
        let room = attempt
            .route
            .room_id
            .as_str()
            .try_into()
            .map_err(|_| Error::Wire)?;
        machine
            .discard_room_key(room)
            .await
            .map_err(|_| Error::OutcomeUnknown)?;
        let settings = EncryptionSettings {
            sharing_strategy: CollectStrategy::OnlyTrustedDevices,
            ..EncryptionSettings::default()
        };
        let shares = machine
            .share_room_key(room, users.iter().map(|u| u.as_ref()), settings)
            .await
            .map_err(|_| Error::OutcomeUnknown)?;
        if shares.len() > 16 {
            return Err(Error::Capacity);
        }
        let mut actual = BTreeSet::new();
        let mut writes = Vec::new();
        for share in shares {
            if share.event_type.to_string() != "m.room.encrypted" {
                return Err(Error::Recipients);
            }
            let messages = serde_json::to_value(&share.messages).map_err(|_| Error::Storage)?;
            for (user, devices) in messages.as_object().ok_or(Error::Storage)? {
                for device in devices.as_object().ok_or(Error::Storage)?.keys() {
                    if !actual.insert((user.clone(), device.clone())) {
                        return Err(Error::Recipients);
                    }
                }
            }
            writes.push(Write::new(
                share.event_type.to_string(),
                share.txn_id.to_string(),
                json!({"messages":messages}),
                false,
            )?);
        }
        if actual != recipients {
            return Err(Error::Recipients);
        }
        let content = ruma::serde::Raw::from_json_string(attempt.content.to_string())
            .map_err(|_| Error::Storage)?;
        // A fresh nonexpired session was created immediately above under this
        // owned worker. No other SDK operation can rotate it between calls.
        let encrypted = machine
            .encrypt_room_event_raw(room, "m.room.message", &content)
            .await
            .map_err(|_| Error::OutcomeUnknown)?;
        writes.push(Write::new(
            "m.room.encrypted".into(),
            attempt.transaction_id.clone(),
            serde_json::to_value(encrypted.content).map_err(|_| Error::Storage)?,
            true,
        )?);
        let keys_digest = state::hash(state::encode(response, state::MAX_QUERY)?.as_bytes());
        drop(guard);
        let attempt = self.journal.outgoing.as_mut().ok_or(Error::Storage)?;
        attempt.keys_digest = Some(keys_digest);
        attempt.writes = writes;
        attempt.phase = Phase::Ready;
        Ok(())
    }
}
fn users(attempt: &Attempt) -> Result<Vec<OwnedUserId>, Error> {
    attempt
        .joined
        .iter()
        .map(|u| u.parse().map_err(|_| Error::Wire))
        .collect()
}
fn validate_keys_shape(attempt: &Attempt, value: &Value) -> Result<(), Error> {
    if value
        .get("failures")
        .is_some_and(|v| v.as_object().is_none_or(|o| !o.is_empty()))
    {
        return Err(Error::Recipients);
    }
    let keys = value
        .get("device_keys")
        .and_then(Value::as_object)
        .ok_or(Error::Wire)?;
    if keys.keys().cloned().collect::<BTreeSet<_>>() != attempt.joined {
        return Err(Error::Recipients);
    }
    let mut count = 0;
    for (user, devices) in keys {
        count += devices.as_object().ok_or(Error::Wire)?.len();
        if value.get("master_keys").and_then(|v| v.get(user)).is_none()
            || value
                .get("self_signing_keys")
                .and_then(|v| v.get(user))
                .is_none()
        {
            return Err(Error::Recipients);
        }
    }
    if count > 64 {
        return Err(Error::Capacity);
    }
    Ok(())
}

fn same_fields(fresh: &Value, accepted: &Value, fields: &[&str]) -> bool {
    fresh.is_object()
        && accepted.is_object()
        && fields
            .iter()
            .all(|key| fresh.get(*key).is_some() && fresh.get(*key) == accepted.get(*key))
}
