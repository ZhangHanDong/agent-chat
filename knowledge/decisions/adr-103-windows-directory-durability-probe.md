---
kind: decision
id: ADR-103
title: "Qualify a retained NTFS directory flush with an ordinary token"
status: Accepted
tags: [rust, windows, media, probe]
---

## Context

ADR066 preserves FileSyncedDirectoryUnconfirmed on Windows when the actual
retained directory flush fails. cap-primitives4.0.3 opens ordinary directory
capabilities with read access; FlushFileBuffers requires write access. Historical
negative tests do not identify the exact syscall failure or prove that a
write-capable retained-object operation cannot work with ordinary permissions.

Microsoft MS-FSA2.1.5.7 describes directory structure persistence during flush;
Appendix A footnote80 restricts that behavior to NTFS and warns that other
filesystems may acknowledge without performing it. A successful arbitrary-volume
flush is therefore insufficient. Sources: [flush algorithm](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/0de7dc40-9627-437e-a4df-c4696cdc3d02),
[product behavior](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4e3695bd-7574-4f24-a223-b4679c065b63),
[FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).

## Decision

Add only a disposable native Windows example and isolated feature-branch/manual
workflow. The example requires a restricted same-user effective token, full
retained-object identity, strict current-SID permissions, actual local NTFS device
classification, and real file plus directory acknowledgements. The pinned
capability-relative dot open requests read/write with no create/truncate or
share-delete, and has no pathname or alternative syscall fallback.

Only a qualifying candidate feeds the unchanged Store through a retained Dir.
Actual Snapshot, Codec Encrypted, PreparedEncrypted and exact original receipt
are used, with one record and fixed byte bounds. A second child process validates
original ciphertext and descriptor commitments after all first-child owners
exit. Static diagnostics and the first nonzero verdict are preserved. Unsupported
platforms do not return success. Current production behavior and upload gates
remain unchanged regardless of probe outcome.

The controller owns a fresh fixture and at most one exact child at a time. Each
child has a fixed mode and no operator path arguments; the controller supplies
only its newly created fixture through the child's current directory. Child
wall expiry is unknown and requires killing and reaping that owned process.
This is not a promise that a kernel flush is cancellable. At most four direct
probe file/directory handles coexist, plus the existing single Store/Workspace
bounded internal custody. Token query memory is fixed and diagnostics contain
no private identifiers or material. The crate's production unsafe prohibition
remains explicit; only audited example FFI modules permit unsafe.

The original native run34574539701 at06e859d failed before candidate sync:
ordinary-token, RW same-object/privacy and NTFS/type7 checks passed, but the
observed characteristics0x20020 exceeded the initial mounted-only whitelist.
Baseline read-only sync returned actual error5. The follow-up admits only the
exact named FILE_DEVICE_ALLOW_APPCONTAINER_TRAVERSAL bit alongside mounted,
with actual TokenIsAppContainer=false and zero enabled privileges. MS-FSCC
specifies this bit changes traversal checks only for app-container tokens with
traversal privilege; it does not classify remote or virtual storage. Every
other bit still refuses. [Device characteristics](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/616b66d5-b335-4e1c-8f87-b4a55e8d3e4a).
The original failure stays failed; its artifact contains original_exit=78.

The next original run34575483160 atd2249e9 observed a real successful
candidate directory-before flush, then failed negative_remove with error5.
No stage/recovery ran. Pinned cap-primitives Windows remove_file reconstructs
an ambient pathname before std deletion; the single error does not identify
which substep refused. Probe cleanup therefore requests DELETE at the exact
synthetic create_new and uses FileDispositionInfo on that retained handle,
requires an actual delete-pending observation, closes it, and confirms fresh
create_new. It never changes readonly attributes, enables privileges, deletes
an original journal or substitutes another namespace path. Both preceding
failed runs remain retained. [Handle disposition](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle).

Run34576665452 at8660f2a then acknowledged both actual synthetic file and
directory flushes, plus handle cleanup, but refused the path-reconstructing
held rename with error5. It still reached no Store or restart restoration.
The probe now opens the fixed source relative to the retained root with DELETE
and requires sharing violation32 while original custody is held. After release,
the same rooted open and private/full-ID check precede no-replace FileRenameInfo
with the actual RootDirectory and fixed UTF16 leaf. It verifies unchanged full
ID on both original handle and new entry. The initialized fixed64-byte buffer
has compile-time pinned field-offset, alignment and capacity assertions. No
path fallback, privilege adjustment or replacement flag is used, and actual
next-run success remains required. [Relative rename](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info).

Run34577475135 at8705e32 actually reached a qualified encrypted Store staging
receipt after the held rooted DELETE-open32 check. Released Win32 rename then
returned87, and fresh-process recovery did not run. MicrosoftDocs history shows
FILE_RENAME_INFO required NULL RootDirectory before its April2026 documentation
change; that update did not establish hosted-version support. The probe now uses
the distinct documented NtSetInformationFile/FileRenameInformation10 contract
and pinned FILE_RENAME_INFORMATION type, keeping its actual RootDirectory and
fixed leaf. It requires immediate and final IOSB success; unexpected pending
exits without unwinding buffers. This changes only the probe rename mechanism,
not production or any positive-evidence requirement. [Documentation history](https://github.com/MicrosoftDocs/sdk-api/commit/d1debc569f40cda761474d216903f27c8aa7c7af),
[native rename API](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile).

Run34578232660 ate7ba863 reached qualified stage and actual immediate/final
NT rename success, then destination open failed32 while the DELETE source was
still held. Pinned cap-primitives4.0.3 oflags.rs clears FILE_SHARE_DELETE for
maybe_dir opens even when explicitly requested. The released fixture now checks
original post-rename private/full ID, closes that rename handle, then opens the
fixed destination under the still-retained exclusive root and compares its full
ID/private policy to the frozen original. The held32 gate is unchanged. This
is released fixture validation, not a new atomic namespace authority guarantee;
fresh-process restoration remains required and the original failure is retained.

## Consequences

A positive result qualifies the observed local NTFS OS-acknowledgement mechanism
under the tested token and host provisioning. It does not test power loss,
hardware cache honesty, every Windows filesystem, or application file delivery.
A refusal retains its exact phase and numeric error; it does not weaken current
FileAndDirectorySynced requirements. Any later production change requires its
own contract and an explicit filesystem gate.

## Alternatives Considered

Raw-volume/admin flushes, remote filesystems, data-only/no-sync flags and silent
ReOpenFile or ambient-path fallbacks are excluded. Merely changing read access
to write access in production would lack actual platform and filesystem proof.
Keeping the current negative outcome without measuring the concrete ordinary
NTFS candidate would leave a potentially supportable mechanism unresolved.
