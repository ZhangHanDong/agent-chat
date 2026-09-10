//! The owner thread retains the filesystem lock until accepted SDK work and
//! store shutdown finish, even if its caller cancels or drops the receiver.
use crate::{Error, HostConfig};
use hagency_core::canonical;
use hagency_store::private;
use matrix_sdk_base::{
    BaseClient, DmRoomDefinition, SessionMeta, ThreadingSupport,
    store::{RoomLoadSettings, StoreConfig},
};
use matrix_sdk_common::cross_process_lock::CrossProcessLockConfig;
use matrix_sdk_crypto::store::CryptoStore;
use matrix_sdk_crypto::{DecryptionSettings, TrustRequirement};
use matrix_sdk_sqlite::{SqliteCryptoStore, SqliteStateStore, SqliteStoreConfig};
use matrix_sdk_store_encryption::StoreCipher;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

const JOURNAL: &[u8] = b"hagency.observer.sync.v1";
const DATABASES: [&str; 2] = ["matrix-sdk-state.sqlite3", "matrix-sdk-crypto.sqlite3"];
const MAX_SYNCS: usize = 64;
// StoreCipher JSON ciphertext uses decimal byte arrays. This bounds the full
// encrypted form of one 1 MiB response plus 64 x 4096-byte cursor receipts.
const MAX_JOURNAL_BYTES: usize = 8 * 1024 * 1024;
#[derive(Default, Serialize, Deserialize)]
struct Journal {
    pending: Option<Value>,
    receipts: Vec<(String, String)>,
}
enum Command {
    #[cfg(test)]
    SeedPending(Value, oneshot::Sender<Result<(), Error>>),
    #[cfg(test)]
    CloseFault(oneshot::Sender<()>),
    Cursor(oneshot::Sender<Option<String>>),
    Sync(Value, oneshot::Sender<Result<(), Error>>),
    Close(oneshot::Sender<Result<(), Error>>),
}
pub(crate) struct Owner {
    tx: mpsc::Sender<Command>,
    timeout: Duration,
}
struct Init {
    root: PathBuf,
    key: [u8; 32],
    binding: String,
    user: String,
    device: String,
}
impl Owner {
    pub(crate) async fn open(config: &HostConfig) -> Result<Self, Error> {
        let init = Init {
            root: config.root.clone(),
            key: config.key,
            binding: config.binding()?,
            user: config.identity.transport.sender_mxid.clone(),
            device: config.identity.transport.device_id.clone(),
        };
        let (tx, mut rx) = mpsc::channel(1);
        let (ready, wait) = oneshot::channel();
        std::thread::Builder::new()
            .name("hagency-matrix-sdk".into())
            .spawn(move || {
                // Lock is outside the runtime; background store tasks cannot outlive ownership.
                let prepared = prepare(&init);
                let (lock, fresh) = match prepared {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = ready.send(Err(e));
                        return;
                    }
                };
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = ready.send(Err(Error::Storage));
                        return;
                    }
                };
                let mut ready = Some(ready);
                let mut init_error = None;
                let closed = runtime.block_on(async {
                    let mut sdk = match Sdk::open(&init, fresh).await {
                        Ok(v) => v,
                        Err(e) => {
                            init_error = Some(e);
                            return None;
                        }
                    };
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(Ok(()));
                    }
                    while let Some(command) = rx.recv().await {
                        match command {
                            #[cfg(test)]
                            Command::SeedPending(value, reply) => {
                                sdk.journal.pending = Some(value);
                                let _ = reply.send(sdk.persist().await);
                            }
                            #[cfg(test)]
                            Command::CloseFault(reply) => {
                                sdk.close_fault = true;
                                let _ = reply.send(());
                            }
                            Command::Cursor(reply) => {
                                let _ =
                                    reply.send(sdk.journal.receipts.last().map(|r| r.0.clone()));
                            }
                            Command::Sync(value, reply) => {
                                let result = sdk.sync(value).await;
                                let _ = reply.send(result);
                            }
                            Command::Close(reply) => {
                                let result = sdk.close().await;
                                return Some((reply, result));
                            }
                        }
                    }
                    let _ = sdk.client.close_stores().await;
                    None
                });
                drop(runtime);
                drop(lock);
                if let Some(ready) = ready {
                    let _ = ready.send(Err(init_error.unwrap_or(Error::Storage)));
                }
                if let Some((reply, result)) = closed {
                    let _ = reply.send(result);
                }
            })
            .map_err(|_| Error::Storage)?;
        tokio::time::timeout(config.limits.sdk, wait)
            .await
            .map_err(|_| Error::OutcomeUnknown)?
            .map_err(|_| Error::Storage)??;
        Ok(Self {
            tx,
            timeout: config.limits.sdk,
        })
    }
    pub(crate) async fn cursor(&self) -> Result<Option<String>, Error> {
        let (send, reply) = oneshot::channel();
        self.tx
            .try_send(Command::Cursor(send))
            .map_err(|_| Error::Busy)?;
        tokio::time::timeout(self.timeout, reply)
            .await
            .map_err(|_| Error::OutcomeUnknown)?
            .map_err(|_| Error::Storage)
    }
    pub(crate) async fn sync(&self, value: Value) -> Result<(), Error> {
        // Only one accepted queued 1 MiB response + one executing response. The
        // private collector validates full serialized byte/event bounds first.
        let (send, reply) = oneshot::channel();
        self.tx
            .try_send(Command::Sync(value, send))
            .map_err(|_| Error::Busy)?;
        tokio::time::timeout(self.timeout, reply)
            .await
            .map_err(|_| Error::OutcomeUnknown)?
            .map_err(|_| Error::OutcomeUnknown)?
    }
    pub(crate) async fn close(self) -> Result<(), Error> {
        let (send, reply) = oneshot::channel();
        self.tx
            .try_send(Command::Close(send))
            .map_err(|_| Error::Busy)?;
        drop(self.tx);
        tokio::time::timeout(self.timeout, reply)
            .await
            .map_err(|_| Error::OutcomeUnknown)?
            .map_err(|_| Error::Storage)?
    }
}
fn read(path: &Path, max: u64) -> Result<Vec<u8>, Error> {
    let file = private::open(path, false).map_err(|_| Error::Storage)?;
    if file.metadata().map_err(|_| Error::Storage)?.len() > max {
        return Err(Error::Storage);
    }
    let mut b = vec![];
    file.take(max + 1)
        .read_to_end(&mut b)
        .map_err(|_| Error::Storage)?;
    if b.len() as u64 > max {
        return Err(Error::Storage);
    }
    Ok(b)
}
fn files(root: &Path) -> Result<(), Error> {
    let entries = fs::read_dir(root)
        .map_err(|_| Error::Storage)?
        .take(16)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Error::Storage)?;
    if entries.len() >= 16 {
        return Err(Error::Storage);
    }
    for e in entries {
        let name = e.file_name();
        let name = name.to_str().ok_or(Error::Storage)?;
        if matches!(name, "sdk.lock" | "binding" | "identity" | "journal.key") {
            private::open(&e.path(), false).map_err(|_| Error::Storage)?;
            continue;
        }
        let db = DATABASES.contains(&name);
        let journal = DATABASES.iter().any(|d| {
            ["-wal", "-shm", "-journal"]
                .iter()
                .any(|s| name == format!("{d}{s}"))
        });
        if !db && !journal {
            return Err(Error::Storage);
        }
        let f = if journal {
            private::open_journal(&e.path())
        } else {
            private::open(&e.path(), false)
        }
        .map_err(|_| Error::Storage)?;
        if f.metadata().map_err(|_| Error::Storage)?.len() > 64 * 1024 * 1024 {
            return Err(Error::Capacity);
        }
    }
    Ok(())
}
fn prepare(init: &Init) -> Result<(File, bool), Error> {
    private::directory(&init.root).map_err(|_| Error::Storage)?;
    let path = init.root.join("sdk.lock");
    let lock = private::open(&path, !path.try_exists().map_err(|_| Error::Storage)?)
        .map_err(|_| Error::Storage)?;
    lock.try_lock().map_err(|_| Error::Busy)?;
    files(&init.root)?;
    let fresh = !init
        .root
        .join("binding")
        .try_exists()
        .map_err(|_| Error::Storage)?;
    if fresh {
        if DATABASES.iter().any(|d| init.root.join(d).exists())
            || init.root.join("identity").exists()
        {
            return Err(Error::Storage);
        }
        // An interrupted fresh bootstrap remains quarantined; never recreate keys.
        private::write_new(&init.root.join("binding"), init.binding.as_bytes())
            .map_err(|_| Error::Storage)?;
        let cipher = StoreCipher::new().map_err(|_| Error::Storage)?;
        private::write_new(
            &init.root.join("journal.key"),
            &cipher
                .export_with_key(&init.key)
                .map_err(|_| Error::Storage)?,
        )
        .map_err(|_| Error::Storage)?;
        for db in DATABASES {
            private::open(&init.root.join(db), true).map_err(|_| Error::Storage)?;
        }
    } else {
        if read(&init.root.join("binding"), 64)? != init.binding.as_bytes()
            || read(&init.root.join("identity"), 256)?.is_empty()
        {
            return Err(Error::Identity);
        }
        for db in DATABASES {
            let f = private::open(&init.root.join(db), false).map_err(|_| Error::Storage)?;
            if f.metadata().map_err(|_| Error::Storage)?.len() == 0 {
                return Err(Error::Storage);
            }
        }
    }
    Ok((lock, fresh))
}
struct Sdk {
    client: BaseClient,
    root: PathBuf,
    journal: Journal,
    cipher: StoreCipher,
    #[cfg(test)]
    close_fault: bool,
}
impl Sdk {
    async fn open(init: &Init, fresh: bool) -> Result<Self, Error> {
        let cipher =
            StoreCipher::import_with_key(&init.key, &read(&init.root.join("journal.key"), 1024)?)
                .map_err(|_| Error::Storage)?;
        let config = SqliteStoreConfig::new(&init.root)
            .key(Some(&init.key))
            .pool_max_size(2)
            .cache_size(500_000)
            .journal_size_limit(2_000_000);
        let state = SqliteStateStore::open_with_config(&config)
            .await
            .map_err(|_| Error::Storage)?;
        let crypto = SqliteCryptoStore::open_with_config(&config)
            .await
            .map_err(|_| Error::Storage)?;
        if !fresh
            && crypto
                .load_account()
                .await
                .map_err(|_| Error::Storage)?
                .is_none()
        {
            return Err(Error::Storage);
        }
        let mut client = BaseClient::new(
            StoreConfig::new(CrossProcessLockConfig::SingleProcess)
                .state_store(state)
                .crypto_store(crypto),
            ThreadingSupport::Disabled,
            DmRoomDefinition::default(),
        );
        client.decryption_settings = DecryptionSettings {
            sender_device_trust_requirement: TrustRequirement::CrossSigned,
        };
        client.handle_verification_events = false;
        let meta = SessionMeta {
            user_id: init.user.parse().map_err(|_| Error::Config)?,
            device_id: init.device.as_str().into(),
        };
        // Only this collector can populate these stores: fixed <=16 room IDs and
        // <=64 bounded sync batches, so RoomLoadSettings::All stays finite.
        client
            .activate(meta, RoomLoadSettings::All, None)
            .await
            .map_err(|_| Error::Storage)?;
        let result = async {
            let guard = client.olm_machine().await;
            let keys = guard.as_ref().ok_or(Error::Storage)?.identity_keys();
            let identity = format!(
                "{}:{}",
                keys.ed25519.to_base64(),
                keys.curve25519.to_base64()
            );
            drop(guard);
            if fresh {
                private::write_new(&init.root.join("identity"), identity.as_bytes())
                    .map_err(|_| Error::Storage)?;
            } else if read(&init.root.join("identity"), 256)? != identity.as_bytes() {
                return Err(Error::Identity);
            }
            let stored = client
                .state_store()
                .get_custom_value(JOURNAL)
                .await
                .map_err(|_| Error::Storage)?;
            let journal = match stored {
                Some(bytes) => {
                    if bytes.len() > MAX_JOURNAL_BYTES {
                        return Err(Error::Capacity);
                    }
                    cipher
                        .decrypt_value::<Journal>(&bytes)
                        .map_err(|_| Error::Storage)?
                }
                None if fresh => Journal::default(),
                None => return Err(Error::Storage),
            };
            if journal.pending.is_some() {
                return Err(Error::OutcomeUnknown);
            }
            if journal.receipts.len() > MAX_SYNCS {
                return Err(Error::Storage);
            }
            if fresh {
                client
                    .state_store()
                    .set_custom_value(
                        JOURNAL,
                        cipher.encrypt_value(&journal).map_err(|_| Error::Storage)?,
                    )
                    .await
                    .map_err(|_| Error::Storage)?;
            }
            files(&init.root)?;
            Ok(journal)
        }
        .await;
        match result {
            Ok(journal) => Ok(Self {
                client,
                root: init.root.clone(),
                journal,
                cipher,
                #[cfg(test)]
                close_fault: false,
            }),
            Err(e) => {
                let _ = client.close_stores().await;
                Err(e)
            }
        }
    }
    async fn close(&self) -> Result<(), Error> {
        let result = self
            .client
            .close_stores()
            .await
            .map_err(|_| Error::OutcomeUnknown);
        #[cfg(test)]
        if self.close_fault {
            return Err(Error::OutcomeUnknown);
        }
        result
    }
    async fn persist(&self) -> Result<(), Error> {
        let bytes = self
            .cipher
            .encrypt_value(&self.journal)
            .map_err(|_| Error::Storage)?;
        if bytes.len() > MAX_JOURNAL_BYTES {
            return Err(Error::Capacity);
        }
        self.client
            .state_store()
            .set_custom_value(JOURNAL, bytes)
            .await
            .map_err(|_| Error::OutcomeUnknown)?;
        Ok(())
    }
    async fn sync(&mut self, value: Value) -> Result<(), Error> {
        if self.journal.pending.is_some() {
            return Err(Error::OutcomeUnknown);
        }
        files(&self.root)?;
        let token = value
            .get("next_batch")
            .and_then(Value::as_str)
            .ok_or(Error::Wire)?
            .to_owned();
        let digest = canonical::transport_digest(&value).map_err(|_| Error::Wire)?;
        if let Some((_, old)) = self.journal.receipts.iter().find(|(t, _)| *t == token) {
            return if *old == digest {
                Ok(())
            } else {
                Err(Error::Conflict)
            };
        }
        if self.journal.receipts.len() >= MAX_SYNCS {
            return Err(Error::Capacity);
        }
        use ruma::api::IncomingResponse;
        let response = ruma::api::client::sync::sync_events::v3::Response::try_from_http_response(
            http::Response::builder()
                .body(serde_json::to_vec(&value).map_err(|_| Error::Wire)?)
                .map_err(|_| Error::Wire)?,
        )
        .map_err(|_| Error::Wire)?;
        self.journal.pending = Some(value);
        self.persist().await?;
        self.client
            .receive_sync_response(response)
            .await
            .map_err(|_| Error::OutcomeUnknown)?;
        self.journal.receipts.push((token, digest));
        self.journal.pending = None;
        if self.persist().await.is_err() {
            self.journal.pending = Some(Value::Null);
            return Err(Error::OutcomeUnknown);
        }
        files(&self.root)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HostIdentity, HostRoom, Limits};
    use hagency_core::replies::*;
    use matrix_sdk_base::store::StateStore;
    use serde_json::json;
    pub(super) fn config(root: &Path) -> HostConfig {
        HostConfig::new(
            HostIdentity {
                server_name: "example.test".into(),
                registration_fingerprint: "a".repeat(64),
                transport: MatrixTransportObservation {
                    engagement_id: "fixture".into(),
                    registration_generation: 1,
                    generation: 1,
                    sender_mxid: "@worker:example.test".into(),
                    device_id: "DEVICE".into(),
                },
            },
            "http://127.0.0.1:19999/",
            "synthetic-token-no-network",
            root.join("sdk"),
            [42; 32],
            vec![HostRoom {
                room_id: "!room:example.test".into(),
                generation: 1,
                privacy: RoomPrivacy::Group {},
            }],
            Limits::default(),
        )
        .unwrap()
    }
    fn response(token: &str) -> Value {
        json!({"next_batch":token,"rooms":{"join":{}},"to_device":{"events":[]}})
    }
    #[tokio::test]
    async fn native_matrix_transport_storage_private_exclusive_encrypted_and_no_key_reset() {
        let root = tempfile::tempdir().unwrap();
        let c = config(root.path());
        let owner = Owner::open(&c).await.unwrap();
        assert!(matches!(Owner::open(&c).await, Err(Error::Busy)));
        owner.sync(response("first")).await.unwrap();
        let keys = read(&c.root.join("identity"), 256).unwrap();
        owner.close().await.unwrap();
        let owner = Owner::open(&c).await.unwrap();
        assert_eq!(owner.cursor().await.unwrap(), Some("first".into()));
        owner.close().await.unwrap();
        assert_eq!(read(&c.root.join("identity"), 256).unwrap(), keys);
        let mut wrong = config(root.path());
        wrong.key = [43; 32];
        assert!(matches!(Owner::open(&wrong).await, Err(Error::Storage)));
        wrong = config(root.path());
        wrong.identity.transport.device_id = "OTHER".into();
        assert!(matches!(Owner::open(&wrong).await, Err(Error::Identity)));
        // A nonempty foreign or reset crypto database must not create a replacement account.
        fs::remove_file(c.root.join(DATABASES[1])).unwrap();
        assert!(matches!(Owner::open(&c).await, Err(Error::Storage)));
        assert_eq!(read(&c.root.join("identity"), 256).unwrap(), keys);
        let legacy = tempfile::tempdir().unwrap();
        let c = config(legacy.path());
        private::directory(&c.root).unwrap();
        private::write_new(&c.root.join(DATABASES[1]), b"old NAPI state").unwrap();
        assert!(matches!(Owner::open(&c).await, Err(Error::Storage)));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn native_matrix_transport_storage_rejects_links_and_public_files() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        for mode in ["public", "symlink", "hardlink"] {
            let root = tempfile::tempdir().unwrap();
            let c = config(root.path());
            let owner = Owner::open(&c).await.unwrap();
            owner.close().await.unwrap();
            let db = c.root.join(DATABASES[1]);
            match mode {
                "public" => fs::set_permissions(&db, fs::Permissions::from_mode(0o644)).unwrap(),
                "symlink" => {
                    let old = root.path().join("old");
                    fs::rename(&db, &old).unwrap();
                    symlink(&old, &db).unwrap();
                }
                _ => fs::hard_link(&db, root.path().join("link")).unwrap(),
            };
            assert!(
                matches!(Owner::open(&c).await, Err(Error::Storage)),
                "{mode}"
            );
        }
    }
    #[tokio::test]
    async fn native_matrix_transport_storage_pending_unknown_keeps_full_encrypted_response() {
        let root = tempfile::tempdir().unwrap();
        let c = config(root.path());
        let owner = Owner::open(&c).await.unwrap();
        let pending = json!({"next_batch":"uncertain","rooms":{"join":{}},"to_device":{"events":[{"type":"fixture","content":{"body":"secret-pending-canary","large":"sensitive_pending_".repeat(50000),"fraction":0.125}}]}});
        let (send, reply) = oneshot::channel();
        owner
            .tx
            .try_send(Command::SeedPending(pending.clone(), send))
            .unwrap();
        reply.await.unwrap().unwrap();
        owner.close().await.unwrap();
        let sqlite = SqliteStoreConfig::new(&c.root)
            .key(Some(&c.key))
            .pool_max_size(2);
        let cipher =
            StoreCipher::import_with_key(&c.key, &read(&c.root.join("journal.key"), 1024).unwrap())
                .unwrap();
        assert_eq!(Owner::open(&c).await.err(), Some(Error::OutcomeUnknown));
        let store = SqliteStateStore::open_with_config(&sqlite).await.unwrap();
        let bytes = store.get_custom_value(JOURNAL).await.unwrap().unwrap();
        let journal: Journal = cipher.decrypt_value(&bytes).unwrap();
        assert_eq!(journal.pending, Some(pending));
        store.close().await.unwrap();
        drop(store);
        for db in DATABASES {
            assert!(
                !fs::read(c.root.join(db))
                    .unwrap()
                    .windows(b"secret-pending-canary".len())
                    .any(|b| b == b"secret-pending-canary")
            );
        }
    }
    #[tokio::test]
    async fn native_matrix_transport_bounds_sync_receipts_replay_capacity_and_rollback() {
        let root = tempfile::tempdir().unwrap();
        let c = config(root.path());
        let owner = Owner::open(&c).await.unwrap();
        for n in 0..MAX_SYNCS {
            owner.sync(response(&format!("batch{n}"))).await.unwrap();
        }
        owner.sync(response("batch0")).await.unwrap();
        let mut changed = response("batch0");
        changed["fixture"] = json!(0.125);
        assert_eq!(owner.sync(changed).await, Err(Error::Conflict));
        assert_eq!(owner.sync(response("overflow")).await, Err(Error::Capacity));
        owner.close().await.unwrap();
        let owner = Owner::open(&c).await.unwrap();
        assert_eq!(owner.sync(response("overflow")).await, Err(Error::Capacity));
        owner.close().await.unwrap();
        let root = tempfile::tempdir().unwrap();
        let c = config(root.path());
        let owner = Owner::open(&c).await.unwrap();
        let sql = rusqlite::Connection::open(c.root.join(DATABASES[0])).unwrap();
        sql.execute_batch("CREATE TRIGGER fixture_abort BEFORE INSERT ON kv_blob BEGIN SELECT RAISE(ABORT,'fixture transaction rollback'); END;").unwrap();
        assert_eq!(
            owner.sync(response("blocked")).await,
            Err(Error::OutcomeUnknown)
        );
        assert_eq!(
            owner.sync(response("another")).await,
            Err(Error::OutcomeUnknown)
        );
        sql.execute_batch("DROP TRIGGER fixture_abort").unwrap();
        drop(sql);
        owner.close().await.unwrap();
        let owner = Owner::open(&c).await.unwrap();
        assert_eq!(owner.cursor().await.unwrap(), None);
        owner.close().await.unwrap();
    }
}

#[cfg(test)]
mod delayed_owner_tests {
    use super::*;
    #[tokio::test]
    async fn native_matrix_transport_storage_queued_timeout_keeps_owner_and_commit_receipt() {
        let root = tempfile::tempdir().unwrap();
        let config = super::tests::config(root.path());
        let mut owner = Owner::open(&config).await.unwrap();
        owner.timeout = Duration::from_millis(20);
        let sql = rusqlite::Connection::open(config.root.join(DATABASES[0])).unwrap();
        sql.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let value = serde_json::json!({"next_batch":"delayed","rooms":{"join":{}},"to_device":{"events":[]}});
        assert_eq!(owner.sync(value.clone()).await, Err(Error::OutcomeUnknown));
        assert!(matches!(Owner::open(&config).await, Err(Error::Busy)));
        sql.execute_batch("COMMIT").unwrap();
        drop(sql);
        owner.timeout = Duration::from_secs(10);
        assert_eq!(owner.cursor().await.unwrap(), Some("delayed".into()));
        owner.close().await.unwrap();
        let owner = Owner::open(&config).await.unwrap();
        owner.sync(value).await.unwrap();
        assert_eq!(owner.cursor().await.unwrap(), Some("delayed".into()));
        owner.close().await.unwrap();
    }
}

#[cfg(test)]
mod close_tests {
    use super::*;
    #[tokio::test]
    async fn native_matrix_transport_storage_close_error_never_reports_success() {
        let root = tempfile::tempdir().unwrap();
        let config = super::tests::config(root.path());
        let owner = Owner::open(&config).await.unwrap();
        let (send, reply) = oneshot::channel();
        owner.tx.try_send(Command::CloseFault(send)).unwrap();
        reply.await.unwrap();
        assert_eq!(owner.close().await, Err(Error::OutcomeUnknown));
        // Error acknowledgement follows actual store/runtime termination and lock release.
        let next = Owner::open(&config).await.unwrap();
        next.close().await.unwrap();
    }
}
