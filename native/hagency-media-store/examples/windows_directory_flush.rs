//! Disposable native qualification, never an application durability setter.
#[cfg(windows)]
#[path = "windows_directory_flush/fixture.rs"]
mod fixture;
#[cfg(windows)]
#[allow(unsafe_code)]
#[path = "windows_directory_flush/handles.rs"]
mod handles;
#[cfg(windows)]
#[allow(unsafe_code)]
#[path = "windows_directory_flush/token.rs"]
mod token;

#[cfg(windows)]
#[derive(Clone, Copy)]
struct Failure {
    phase: &'static str,
    code: i64,
}
#[cfg(windows)]
impl Failure {
    fn refused(phase: &'static str) -> Self {
        Self { phase, code: -1 }
    }
    fn io(phase: &'static str, error: std::io::Error) -> Self {
        Self {
            phase,
            code: error.raw_os_error().map_or(-1, i64::from),
        }
    }
    fn last(phase: &'static str) -> Self {
        Self::io(phase, std::io::Error::last_os_error())
    }
}
#[cfg(windows)]
type Result<T> = std::result::Result<T, Failure>;

#[cfg(windows)]
fn execute() -> i32 {
    let result = match std::env::var("HAGENCY_DIRECTORY_PROBE_CHILD").as_deref() {
        Ok("stage") => fixture::child(false),
        Ok("restore") => fixture::child(true),
        Err(std::env::VarError::NotPresent) => fixture::controller(),
        _ => Err(Failure::refused("mode")),
    };
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!(
                "{{\"phase\":\"{}\",\"qualified\":false,\"code\":{}}}",
                error.phase, error.code
            );
            78
        }
    }
}
fn main() {
    #[cfg(windows)]
    std::process::exit(execute());
    #[cfg(not(windows))]
    {
        eprintln!("{{\"phase\":\"platform\",\"qualified\":false,\"code\":-1}}");
        std::process::exit(78);
    }
}

#[cfg(all(test, windows))]
#[test]
fn native_windows_directory_probe() {
    assert_eq!(
        execute(),
        0,
        "actual Windows qualification refused; preserve original evidence"
    );
}
