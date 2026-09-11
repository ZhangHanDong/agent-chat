//! Compare two live directory objects. This is a consistency observation, not
//! a portable identity, namespace lock, or replacement for retaining the objects.
use std::{fs::File, io};

pub fn same_directory(left: &File, right: &File) -> io::Result<bool> {
    if !left.metadata()?.is_dir() || !right.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "directory required",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let left = left.metadata()?;
        let right = right.metadata()?;
        Ok(left.dev() == right.dev() && left.ino() == right.ino())
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx,
        };
        fn identity(file: &File) -> io::Result<FILE_ID_INFO> {
            let mut value = FILE_ID_INFO::default();
            // SAFETY: the borrowed File owns a live handle throughout the call;
            // initialized output has the exact Win32 size and alignment. Read
            // it only after success. Preserve all 128 ID bits (including ReFS).
            if unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle(),
                    FileIdInfo,
                    (&mut value as *mut FILE_ID_INFO).cast(),
                    std::mem::size_of::<FILE_ID_INFO>() as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(value)
        }
        let left = identity(left)?;
        let right = identity(right)?;
        Ok(left.VolumeSerialNumber == right.VolumeSerialNumber
            && left.FileId.Identifier == right.FileId.Identifier)
    }
    #[cfg(not(any(unix, windows)))]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "directory identity unavailable",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn open(path: &std::path::Path) -> File {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
            options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
        }
        options.open(path).unwrap()
    }
    #[test]
    fn native_workspace_directory_identity() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let first = open(root.path());
        assert!(same_directory(&first, &first.try_clone().unwrap()).unwrap());
        assert!(same_directory(&first, &open(root.path())).unwrap());
        assert!(!same_directory(&first, &open(other.path())).unwrap());
        let file = File::create(root.path().join("ordinary")).unwrap();
        assert_eq!(
            same_directory(&first, &file).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
