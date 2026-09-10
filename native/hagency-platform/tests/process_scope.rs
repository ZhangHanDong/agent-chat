use hagency_platform::{Launch, OwnedProcess};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn launch(root: &Path, mode: &str, marker: &Path, extra: &[&str]) -> Launch {
    let mut env = BTreeMap::new();
    env.insert("PATH".into(), "".into());
    env.insert("HAGENCY_PROBE_ALLOWED".into(), "显式 value".into());
    if let Some(value) = std::env::var_os("SystemRoot") {
        env.insert("SystemRoot".into(), value);
    }
    let mut args = vec![OsString::from(mode), marker.as_os_str().to_owned()];
    args.extend(extra.iter().map(OsString::from));
    Launch {
        executable: PathBuf::from(env!("CARGO_BIN_EXE_hagency-platform-probe")),
        arguments: args,
        directory: root.to_owned(),
        environment: env,
        require_crash_containment: false,
    }
}
fn length(marker: &Path) -> u64 {
    fs::metadata(marker.with_extension("pulse")).map_or(0, |v| v.len())
}
fn ready(marker: &Path) {
    let until = Instant::now() + Duration::from_secs(5);
    while length(marker) < 3 {
        assert!(
            Instant::now() < until,
            "native fixture did not become ready"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn stopped(marker: &Path) {
    std::thread::sleep(Duration::from_millis(80));
    let before = length(marker);
    std::thread::sleep(Duration::from_millis(160));
    assert_eq!(
        before,
        length(marker),
        "fixture child still writes after cancellation"
    );
}
#[test]
fn native_process_scope_start_stop() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("工作 区");
    fs::create_dir(&directory).unwrap();
    let marker = directory.join("owned");
    let other = directory.join("unrelated");
    let mut unrelated = OwnedProcess::spawn(&launch(&directory, "leaf", &other, &[])).unwrap();
    ready(&other);
    let arguments = [
        "",
        "汉字 and spaces",
        "quotes\"inside",
        "trailing\\",
        "line\nnext",
        "$() `literal` & | >",
    ];
    let mut owned =
        OwnedProcess::spawn(&launch(&directory, "leader", &marker, &arguments)).unwrap();
    ready(&marker);
    assert_ne!(owned.id(), unrelated.id());
    assert_eq!(
        fs::read_to_string(marker.with_extension("arguments")).unwrap(),
        arguments.join("\0")
    );
    assert_eq!(
        fs::read_to_string(marker.with_extension("environment")).unwrap(),
        "true:true:显式 value"
    );
    let report = owned.stop(Duration::from_secs(2)).unwrap();
    assert!(report.leader_exited);
    assert_eq!(report.whole_tree_stopped, cfg!(windows));
    stopped(&marker);
    let before = length(&other);
    std::thread::sleep(Duration::from_millis(80));
    assert!(length(&other) > before);
    assert_eq!(owned.stop(Duration::from_secs(1)).unwrap(), report); // No reused PID re-signal.
    unrelated.stop(Duration::from_secs(2)).unwrap();
    let mut invalid = launch(&directory, "leaf", &marker, &[]);
    invalid.executable = "relative".into();
    assert!(
        matches!(OwnedProcess::spawn(&invalid),Err(e) if e.kind()==io::ErrorKind::InvalidInput)
    );
    invalid.executable = directory.join(if cfg!(windows) {
        "missing.exe"
    } else {
        "missing"
    });
    assert!(OwnedProcess::spawn(&invalid).is_err());
    invalid = launch(&directory, "leaf", &marker, &[]);
    invalid.arguments.push("NUL\0argument".into());
    assert!(
        matches!(OwnedProcess::spawn(&invalid),Err(e) if e.kind()==io::ErrorKind::InvalidInput)
    );
}
#[test]
fn native_process_scope_early_exit() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("early");
    let mut owned = OwnedProcess::spawn(&launch(root.path(), "early", &marker, &[])).unwrap();
    ready(&marker); // The root has exited; the retained child/job still owns cancellation.
    assert!(owned.stop(Duration::from_secs(2)).unwrap().leader_exited);
    stopped(&marker);
    let marker = root.path().join("drop");
    let owned = OwnedProcess::spawn(&launch(root.path(), "leader", &marker, &[])).unwrap();
    ready(&marker);
    drop(owned);
    stopped(&marker);
}
#[test]
fn native_process_scope_crash_guarantee() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("crash");
    let mut request = launch(root.path(), "leaf", &marker, &[]);
    request.require_crash_containment = true;
    #[cfg(unix)]
    {
        assert!(
            matches!(OwnedProcess::spawn(&request),Err(e) if e.kind()==io::ErrorKind::Unsupported)
        );
        assert_eq!(length(&marker), 0); // No weak fallback launch.
    }
    #[cfg(windows)]
    {
        // Controller exits without Drop; kernel handle closure must kill the job.
        let request = launch(root.path(), "controller-crash", &marker, &[]);
        let mut controller = std::process::Command::new(&request.executable)
            .args(&request.arguments)
            .current_dir(&request.directory)
            .env_clear()
            .envs(&request.environment)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let until = Instant::now() + Duration::from_secs(6);
        loop {
            if let Some(status) = controller.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if Instant::now() >= until {
                let _ = controller.kill();
                let _ = controller.wait();
                panic!("controller fixture timed out");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(marker.with_extension("ready").is_file());
        stopped(&marker);
    }
}
