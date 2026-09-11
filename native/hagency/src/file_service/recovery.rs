use super::{FileError, Setup};
use cap_std::{ambient_authority, fs::Dir};
use hagency_media_store::{HostNamespace, Limits, Store};
use hagency_store::private;

/// The path is fixed host state. It is opened once and retained by the media Store.
/// Existing directories never authorize replacement of a missing original journal.
pub(super) fn open(setup: &Setup) -> Result<Store, FileError> {
    #[cfg(unix)]
    let directory = {
        use std::os::unix::fs::DirBuilderExt;
        let mut directory = std::fs::DirBuilder::new();
        directory.mode(0o700);
        directory
    };
    #[cfg(not(unix))]
    let directory = std::fs::DirBuilder::new();
    // create() is atomic and non-recursive. A path observation alone must never
    // choose journal creation. Windows inherits the fixed private state parent's
    // allowlisted DACL, then the same strict private checker validates it.
    let fresh = match directory.create(&setup.directory) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(_) => return Err(FileError::Unavailable),
    };
    let metadata =
        std::fs::symlink_metadata(&setup.directory).map_err(|_| FileError::Unavailable)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(FileError::Unavailable);
    }
    private::directory(&setup.directory).map_err(|_| FileError::Unavailable)?;
    let dir = Dir::open_ambient_dir(&setup.directory, ambient_authority())
        .map_err(|_| FileError::Unavailable)?;
    let namespace = HostNamespace::new(&setup.namespace).map_err(|_| FileError::Invalid)?;
    let limits =
        Limits::new(setup.limit, 64 * 1024 * 1024, 64, 2).map_err(|_| FileError::Invalid)?;
    let store = if fresh {
        Store::create(dir, namespace, limits)
    } else {
        Store::open(dir, namespace, limits)
    }
    .map_err(|_| FileError::Unknown)?;
    Ok(store)
}
