use clap::{Parser, Subcommand};
use hagency_store::{Repository, Store, private};
use salvo::prelude::*;
use std::{net::SocketAddr, path::PathBuf, time::Duration};

#[derive(Parser)]
#[command(
    version,
    about = "Hagency native migration runtime (isolated development state)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Initialize fresh state. Requires an empty, private directory or a new path.
    Init {
        #[arg(long)]
        state_dir: PathBuf,
    },
    /// Run the isolated native API. Does not load .env or any existing Hagency state.
    Serve {
        #[arg(long)]
        state_dir: PathBuf,
        #[arg(long, default_value = "127.0.0.1:13300")]
        listen: SocketAddr,
        #[arg(long, default_value_t = 16)]
        queue_capacity: usize,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    match Cli::parse().command {
        Command::Init { state_dir } => {
            private::directory(&state_dir)?;
            if std::fs::read_dir(&state_dir)?.next().is_some() {
                return Err("init requires empty state; no existing data will be imported".into());
            }
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(|_| "secure randomness unavailable")?;
            let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            private::write_new(&state_dir.join("operator.token"), token.as_bytes())?;
            drop(Repository::open(&state_dir)?);
            println!(
                "Initialized native state. Operator token is in operator.token; keep it private."
            );
        }
        Command::Serve {
            state_dir,
            listen,
            queue_capacity,
        } => {
            if !listen.ip().is_loopback() || listen.port() == 0 {
                return Err("native development service requires a loopback address".into());
            }
            let token = private::read_secret(&state_dir.join("operator.token"))?;
            let store = Store::start(Repository::open(&state_dir)?, queue_capacity)?;
            let app = hagency::App::new(store.clone(), &token, listen)?;
            let acceptor = TcpListener::new(listen).try_bind().await?;
            let server = Server::new(acceptor).max_connections(64);
            let handle = server.handle();
            tokio::spawn(async move {
                #[cfg(unix)]
                {
                    let mut termination =
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                            .expect("install SIGTERM handler");
                    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = termination.recv() => {} }
                }
                #[cfg(not(unix))]
                let _ = tokio::signal::ctrl_c().await;
                handle.stop_graceful(Some(Duration::from_secs(5)));
            });
            tracing::info!(%listen, "native foundation listening; Agent execution and Matrix transport are unavailable");
            server.try_serve(app.router()).await?;
            store.shutdown().await?;
        }
    }
    Ok(())
}
