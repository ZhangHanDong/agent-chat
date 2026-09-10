#[path = "mcp/stdio.rs"]
mod mcp_stdio;
use clap::{Parser, Subcommand};
use hagency_store::{DomainRepository, DomainStore, Repository, Store, private};
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
    /// Serve scoped task tools over MCP stdio using inherited runner context.
    Mcp,
    /// Maintain the canonical task from the host-provisioned runner environment.
    Task {
        /// Stable identifier for a mutation; reuse only with identical content.
        #[arg(long, global = true)]
        call_id: Option<String>,
        #[command(subcommand)]
        command: hagency::task_client::Command,
    },
    /// Internal native guardian. Requires a private inherited channel on stdin.
    #[cfg(unix)]
    #[command(hide = true)]
    Guardian,
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let command = Cli::parse().command;
    #[cfg(unix)]
    if matches!(command, Command::Guardian) {
        hagency_platform::run_guardian()?;
        return Ok(());
    }
    if matches!(command, Command::Mcp) {
        mcp_stdio::run_stdio()?;
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(command))
}
async fn run(command: Command) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        Command::Mcp => unreachable!("MCP runs on the dedicated main thread"),
        Command::Task { call_id, command } => {
            let context = hagency::task_client::Context::from_env()?;
            let output = hagency::task_client::run(
                &context,
                &command,
                call_id.as_deref(),
                hagency::task_client::DEFAULT_DEADLINE,
            )
            .await?;
            println!("{}", serde_json::to_string(&output)?);
        }
        #[cfg(unix)]
        Command::Guardian => return Err("guardian requires isolated synchronous startup".into()),
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
            drop(DomainRepository::open(&state_dir)?);
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
            let token = private::read_secret(&state_dir.join("operator.token"))
                .map_err(|e| format!("native credential check failed: {e}"))?;
            let store = Store::start(
                Repository::open(&state_dir)
                    .map_err(|e| format!("native custody startup failed: {e}"))?,
                queue_capacity,
            )?;
            let domain = DomainStore::start(
                DomainRepository::open(&state_dir)
                    .map_err(|e| format!("native domain startup failed: {e}"))?,
                queue_capacity,
            )?;
            let app = hagency::App::new(store.clone(), &token, listen)?.with_domain(domain.clone());
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
            domain.shutdown().await?;
        }
    }
    Ok(())
}
