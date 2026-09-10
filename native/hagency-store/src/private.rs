use crate::Error;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub fn directory(path: &Path) -> Result<(), Error> {
    #[cfg(windows)]
    {
        windows::directory(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err(Error::PlatformUnavailable)
    }
    #[cfg(unix)]
    {
        if !path.exists() {
            // Parent must already exist. No recursive creation across uncontrolled paths.
            fs::DirBuilder::new().mode(0o700).create(path)?;
        }
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || meta.mode() & 0o077 != 0
            || meta.uid() != rustix::process::geteuid().as_raw()
        {
            return Err(Error::Private);
        }
        Ok(())
    }
}

fn check(file: &File, path: &Path) -> Result<(), Error> {
    let meta = file.metadata()?;
    let path_meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || path_meta.file_type().is_symlink() {
        return Err(Error::Private);
    }
    #[cfg(unix)]
    if meta.mode() & 0o077 != 0
        || meta.uid() != rustix::process::geteuid().as_raw()
        || meta.nlink() != 1
        || meta.ino() != path_meta.ino()
        || meta.dev() != path_meta.dev()
    {
        return Err(Error::Private);
    }
    #[cfg(windows)]
    windows::check(file, path)?;
    #[cfg(not(any(unix, windows)))]
    return Err(Error::PlatformUnavailable);
    #[cfg(any(unix, windows))]
    Ok(())
}

pub fn open(path: &Path, create: bool) -> Result<File, Error> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    #[cfg(windows)]
    if create {
        let file = windows::create_file(path)?;
        check(&file, path)?;
        return Ok(file);
    }
    let file = if create {
        options.create_new(true).open(path)?
    } else {
        options.open(path)?
    };
    check(&file, path)?;
    Ok(file)
}

/// Create-only so init cannot replace a live token. Existing state is never imported.
pub fn write_new(path: &Path, value: &[u8]) -> Result<(), Error> {
    let mut file = open(path, true)?;
    file.write_all(value)?;
    file.sync_all()?;
    #[cfg(unix)]
    File::open(path.parent().ok_or(Error::Private)?)?.sync_all()?;
    Ok(())
}

pub fn read_secret(path: &Path) -> Result<Vec<u8>, Error> {
    let file = open(path, false)?;
    if file.metadata()?.len() > 512 {
        return Err(Error::Private);
    }
    let mut bytes = Vec::new();
    file.take(513).read_to_end(&mut bytes)?;
    if bytes.len() > 512 {
        return Err(Error::Private);
    }
    Ok(bytes)
}

#[cfg(windows)]
#[allow(unsafe_code)] // Audited Windows FFI boundary; the rest of this crate denies unsafe.
mod windows;
