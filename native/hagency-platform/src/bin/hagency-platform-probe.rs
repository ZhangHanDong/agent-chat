//! Controlled native fixture for platform ownership checks; never launches models.
use hagency_platform::{Launch, OwnedProcess};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
    time::{Duration, Instant},
};

fn environment() -> BTreeMap<std::ffi::OsString, std::ffi::OsString> {
    let mut env = BTreeMap::new();
    env.insert("PATH".into(), "".into());
    if let Some(root) = std::env::var_os("SystemRoot") {
        env.insert("SystemRoot".into(), root);
    }
    env
}
fn pulse(marker: &Path) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(marker.with_extension("pulse"))?;
    let until = Instant::now() + Duration::from_secs(8);
    while Instant::now() < until {
        file.write_all(b"x")?;
        file.flush()?;
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}
fn main() -> io::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() < 2 {
        return Err(io::Error::other("probe mode and marker required"));
    }
    let marker = Path::new(&args[1]);
    match args[0].to_str() {
        Some("leaf") => {
            fs::write(marker.with_extension("entered"), b"entered")?;
            pulse(marker)
        }
        #[cfg(unix)]
        Some("exec-on-command") => {
            use std::os::unix::process::CommandExt;
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(marker.with_extension("pulse"))?;
            let until = Instant::now() + Duration::from_secs(8);
            while !marker.with_extension("exec").exists() {
                if Instant::now() >= until {
                    return Err(io::Error::other("exec fixture timed out"));
                }
                file.write_all(b"x")?;
                file.flush()?;
                std::thread::sleep(Duration::from_millis(10));
            }
            drop(file);
            Err(std::process::Command::new(std::env::current_exe()?)
                .arg("leaf")
                .arg(marker)
                .exec())
        }
        Some("leader") | Some("early") => {
            fs::write(
                marker.with_extension("environment"),
                format!(
                    "{}:{}:{}",
                    std::env::var_os("PATH").is_some_and(|v| v.is_empty()),
                    std::env::var_os("HOME").is_none() && std::env::var_os("USERPROFILE").is_none(),
                    std::env::var("HAGENCY_PROBE_ALLOWED").unwrap_or_default()
                ),
            )?;
            let mut child = std::process::Command::new(std::env::current_exe()?)
                .arg("leaf")
                .arg(marker)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()?;
            fs::write(
                marker.with_extension("arguments"),
                args[2..]
                    .iter()
                    .map(|v| v.to_str().unwrap_or("invalid Unicode"))
                    .collect::<Vec<_>>()
                    .join("\0"),
            )?;
            fs::write(marker.with_extension("child"), child.id().to_string())?;
            if args[0] == "early" {
                // Deliberately exit without waiting: cleanup must retain the group/job.
                std::process::exit(0);
            }
            let status = child.wait()?;
            if status.success() {
                Ok(())
            } else {
                Err(io::Error::other("fixture child stopped"))
            }
        }
        Some("controller-crash") => {
            let _owned = OwnedProcess::spawn(&Launch {
                executable: std::env::current_exe()?,
                arguments: vec!["leaf".into(), marker.as_os_str().into()],
                directory: std::env::current_dir()?,
                environment: environment(),
                require_crash_containment: true,
            })?;
            let until = Instant::now() + Duration::from_secs(5);
            while fs::metadata(marker.with_extension("pulse")).map_or(true, |v| v.len() < 2) {
                if Instant::now() >= until {
                    return Err(io::Error::other("fixture did not become ready"));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            fs::write(marker.with_extension("ready"), b"ready")?;
            // Models abrupt owner exit: destructors are intentionally not run.
            std::process::exit(0);
        }
        _ => Err(io::Error::other("unknown native probe mode")),
    }
}
