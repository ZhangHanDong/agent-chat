//! Shared private-file and SQLite startup policy for explicitly named stores.
use crate::{Error, private};
use rusqlite::{Connection, TransactionBehavior};
use std::{fs::File, path::Path, time::Duration};

pub(crate) struct Database {
    pub connection: Connection,
    pub ownership: File,
}
pub(crate) struct Schema {
    pub name: &'static str,
    pub lock: &'static str,
    pub application_id: i32,
    pub version: i32,
    pub sql: &'static str,
    pub verify: &'static str,
}
pub(crate) fn open(directory: &Path, definition: Schema) -> Result<Database, Error> {
    let Schema {
        name: database_name,
        lock: lock_name,
        application_id,
        version: expected_version,
        sql: schema,
        verify: verify_sql,
    } = definition;
    private::directory(directory)?;
    let lock_path = directory.join(lock_name);
    let lock = match private::open(&lock_path, true) {
        Ok(lock) => lock,
        Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            private::open(&lock_path, false)?
        }
        Err(e) => return Err(e),
    };
    lock.try_lock().map_err(|_| Error::Locked)?;
    let path = directory.join(database_name);
    let new = match private::open(&path, true) {
        Ok(_) => true,
        Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            private::open(&path, false)?;
            false
        }
        Err(e) => return Err(e),
    };
    for suffix in ["-wal", "-shm", "-journal"] {
        let suffix = format!("{database_name}{suffix}");
        if directory.join(&suffix).symlink_metadata().is_ok() {
            private::open_journal(&directory.join(&suffix))?;
        }
    }
    let mut db = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_millis(100))?;
    if new {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(schema)?;
        tx.pragma_update(None, "application_id", application_id)?;
        tx.pragma_update(None, "user_version", expected_version)?;
        tx.commit()?;
    } else {
        let id: i32 = db
            .pragma_query_value(None, "application_id", |r| r.get(0))
            .map_err(|_| Error::Schema)?;
        let version: i32 = db
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|_| Error::Schema)?;
        if id != application_id || version != expected_version {
            return Err(Error::Schema);
        }
        let check: String = db
            .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
            .map_err(|_| Error::Schema)?;
        if check != "ok" {
            return Err(Error::Schema);
        }
        db.prepare(verify_sql).map_err(|_| Error::Schema)?;
    }
    db.pragma_update(None, "journal_mode", "WAL")?;
    db.pragma_update(None, "synchronous", "FULL")?;
    db.pragma_update(None, "foreign_keys", "ON")?;
    Ok(Database {
        connection: db,
        ownership: lock,
    })
}
