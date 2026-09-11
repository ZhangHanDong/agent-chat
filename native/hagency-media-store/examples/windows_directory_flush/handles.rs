//! Pinned bindings; no raw volume, pathname fallback or unowned handle escape.
use super::{Failure, Result};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
use cap_std::fs::{Dir, OpenOptions, OpenOptionsExt};
use hagency_store::private;
use std::{fs::File, io::Write, os::windows::io::AsRawHandle, ptr};
use windows_sys::{
    Wdk::{
        Storage::FileSystem::{FileFsDeviceInformation, NtQueryVolumeInformationFile},
        System::SystemServices::FILE_FS_DEVICE_INFORMATION,
    },
    Win32::{
        Security::{
            Authorization::{SE_FILE_OBJECT, SetSecurityInfo},
            DACL_SECURITY_INFORMATION,
        },
        Storage::FileSystem::*,
        System::{IO::IO_STATUS_BLOCK, SystemServices::FILE_READ_ONLY_VOLUME},
    },
};

fn identity(file: &File) -> Result<FILE_ID_INFO> {
    private::check_handle(file).map_err(|_| Failure::refused("private_acl"))?;
    if !file
        .metadata()
        .map_err(|e| Failure::io("metadata", e))?
        .is_dir()
    {
        return Err(Failure::refused("directory_type"));
    }
    let mut info = FILE_ID_INFO::default();
    // SAFETY: File owns the handle; the initialized exact output type and size
    // correspond to FileIdInfo. No pointer or handle outlives the borrow.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(Failure::last("full_file_id"));
    }
    Ok(info)
}
pub(super) fn candidate(dir: &Dir) -> Result<File> {
    let original = dir
        .try_clone()
        .map_err(|e| Failure::io("baseline_clone", e))?
        .into_std_file();
    let before = identity(&original)?;
    let baseline = original.sync_all();
    println!(
        "{{\"phase\":\"baseline_sync\",\"ack\":{},\"code\":{}}}",
        baseline.is_ok(),
        baseline.err().and_then(|e| e.raw_os_error()).unwrap_or(0)
    );
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .maybe_dir(true)
        .follow(FollowSymlinks::No)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    let candidate = dir
        .open_with(".", &options)
        .map_err(|e| Failure::io("rw_dot_open", e))?
        .into_std();
    let after = identity(&candidate)?;
    if before.VolumeSerialNumber != after.VolumeSerialNumber
        || before.FileId.Identifier != after.FileId.Identifier
    {
        return Err(Failure::refused("same_object"));
    }
    println!("{{\"phase\":\"same_object\",\"full_identity\":true,\"private_acl\":true}}");
    profile(&candidate)?;
    candidate
        .sync_all()
        .map_err(|e| Failure::io("directory_before", e))?;
    println!("{{\"phase\":\"directory_before\",\"ack\":true}}");
    Ok(candidate)
}
fn profile(file: &File) -> Result<()> {
    let mut filesystem = [0u16; 32];
    let mut flags = 0;
    // SAFETY: Only a borrowed actual directory handle, fixed initialized output
    // buffers, and explicitly optional null outputs are passed synchronously.
    if unsafe {
        GetVolumeInformationByHandleW(
            file.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut flags,
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    } == 0
    {
        return Err(Failure::last("filesystem_query"));
    }
    if filesystem[..5] != [78, 84, 70, 83, 0] || flags & FILE_READ_ONLY_VOLUME != 0 {
        return Err(Failure::refused("ntfs_profile"));
    }
    let mut device = FILE_FS_DEVICE_INFORMATION::default();
    let mut status = IO_STATUS_BLOCK::default();
    // SAFETY: This is the pinned native signature with exact initialized result
    // structs and live handle. The relative open is synchronous. STATUS_PENDING
    // is an unexpected asynchronous ownership boundary: terminate the child
    // without unwinding the live result storage. Other failures are refused.
    let result = unsafe {
        NtQueryVolumeInformationFile(
            file.as_raw_handle(),
            &mut status,
            (&mut device as *mut FILE_FS_DEVICE_INFORMATION).cast(),
            size_of::<FILE_FS_DEVICE_INFORMATION>() as u32,
            FileFsDeviceInformation,
        )
    };
    if result == 0x103 {
        eprintln!("{{\"phase\":\"device_query_pending\",\"qualified\":false,\"code\":259}}");
        std::process::exit(78);
    }
    if result != 0 {
        return Err(Failure {
            phase: "device_query",
            code: i64::from(result),
        });
    }
    // SAFETY: This operation returns the Status member of the initialized
    // IO_STATUS_BLOCK union; the synchronous successful call has completed.
    let completion = unsafe { status.Anonymous.Status };
    if completion != 0 {
        return Err(Failure {
            phase: "device_completion",
            code: i64::from(completion),
        });
    }
    if status.Information != size_of::<FILE_FS_DEVICE_INFORMATION>() {
        return Err(Failure::refused("device_query_length"));
    }
    println!(
        "{{\"phase\":\"filesystem_profile\",\"ntfs\":true,\"device_type\":{},\"characteristics\":{}}}",
        device.DeviceType, device.Characteristics
    );
    // The optional named app-container traversal bit is classified explicitly.
    // The actual token must not be an app container and has no enabled
    // privileges. Every other characteristic still refuses.
    if !super::supported_profile(device.DeviceType, device.Characteristics) {
        return Err(Failure::refused("local_mounted_disk"));
    }
    Ok(())
}
fn new_file(dir: &Dir) -> Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No)
        .access_mode(
            windows_sys::Win32::Foundation::GENERIC_READ
                | windows_sys::Win32::Foundation::GENERIC_WRITE
                | WRITE_DAC
                | WRITE_OWNER,
        );
    let file = dir
        .open_with("probe.bin", &options)
        .map_err(|e| Failure::io("relative_create", e))?
        .into_std();
    private::seal_created_file_handle(&file).map_err(|_| Failure::refused("created_acl"))?;
    Ok(file)
}
pub(super) fn mutate(dir: &Dir, candidate: &File) -> Result<()> {
    let original_id = identity(candidate)?;
    {
        let file = new_file(dir)?;
        // SAFETY: Only this freshly created empty synthetic fixture is changed.
        // A null DACL deliberately creates a negative private-check fixture;
        // no secret bytes are written and the exact owned entry is removed.
        let result = unsafe {
            SetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
            )
        };
        if result != 0 {
            return Err(Failure {
                phase: "negative_acl_setup",
                code: i64::from(result),
            });
        }
        if private::check_handle(&file).is_ok()
            || file
                .metadata()
                .map_err(|e| Failure::io("negative_metadata", e))?
                .len()
                != 0
        {
            return Err(Failure::refused("negative_acl_refusal"));
        }
    }
    dir.remove_file("probe.bin")
        .map_err(|e| Failure::io("negative_remove", e))?;
    let mut file = new_file(dir)?;
    file.write_all(b"bounded directory flush fixture")
        .map_err(|e| Failure::io("file_write", e))?;
    file.sync_all().map_err(|e| Failure::io("file_sync", e))?;
    candidate
        .sync_all()
        .map_err(|e| Failure::io("directory_after", e))?;
    let after = identity(candidate)?;
    if after.VolumeSerialNumber != original_id.VolumeSerialNumber
        || after.FileId.Identifier != original_id.FileId.Identifier
    {
        return Err(Failure::refused("post_write_identity"));
    }
    println!(
        "{{\"phase\":\"file_and_directory\",\"file_ack\":true,\"directory_ack\":true,\"negative_acl_refused\":true}}"
    );
    drop(file);
    dir.remove_file("probe.bin")
        .map_err(|e| Failure::io("probe_remove", e))?;
    candidate
        .sync_all()
        .map_err(|e| Failure::io("directory_remove", e))?;
    Ok(())
}
