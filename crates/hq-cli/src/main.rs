use anyhow::Result;
use clap::{Parser, Subcommand};
use hq_core::config::HqConfig;
use tracing_subscriber::{EnvFilter, fmt};

mod commands;

#[derive(Parser)]
#[command(name = "hq", version, about = "Agent-HQ: Local-first AI agent hub")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Config file path override
    #[arg(long, global = true)]
    config: Option<String>,

    /// Vault path override
    #[arg(long, global = true)]
    vault: Option<String>,
}

#[derive(Subcommand)]
enum Commands {
    // ─── Getting Started ─────────────────────────────────────────────

    /// Full setup wizard (vault + tools + services)
    Init {
        /// Vault path override
        #[arg(long)]
        vault_path: Option<String>,
        /// Non-interactive mode
        #[arg(long)]
        non_interactive: bool,
    },

    /// First-run setup (scaffold vault only)
    Setup,

    /// System health check (alias for doctor)
    Health,

    /// Diagnose common issues
    Doctor,

    /// Set up API keys interactively
    Env,

    // ─── Chat & Agents ───────────────────────────────────────────────

    /// Interactive terminal chat with an LLM (default command)
    Chat {
        /// Model to use (e.g., anthropic/claude-sonnet-4)
        #[arg(short, long)]
        model: Option<String>,
    },

    /// Spawn agent session with vault context
    #[command(alias = "a")]
    Agent {
        /// Harness: hq, claude, gemini, opencode, codex
        #[arg(default_value = "hq")]
        harness: String,
    },

    // ─── Orchestrator ────────────────────────────────────────────────

    /// Intelligent delegation with discovery + tracing
    #[command(alias = "orch", alias = "o")]
    Orchestrate {
        /// Task description
        instruction: Vec<String>,
        /// Show enriched prompt without executing
        #[arg(long)]
        dry_run: bool,
        /// Force single-step mode
        #[arg(long)]
        single: bool,
    },

    // ─── Services ────────────────────────────────────────────────────

    /// Show vault status and system info
    #[command(alias = "s")]
    Status,

    /// Start HQ components
    Start {
        /// Component: all, agent, daemon, relay, whatsapp, telegram
        #[arg(default_value = "all")]
        component: String,
    },

    /// Stop HQ components
    Stop {
        /// Component: all, agent, daemon, relay, whatsapp, telegram
        #[arg(default_value = "all")]
        component: String,
    },

    /// Restart HQ components (stop + start)
    #[command(alias = "r")]
    Restart {
        /// Component: all, agent, daemon, relay
        #[arg(default_value = "all")]
        component: String,
    },

    // ─── Monitoring ──────────────────────────────────────────────────

    /// View last N log lines
    #[command(alias = "l")]
    Logs {
        /// Service target: agent, relay, daemon, all
        #[arg(default_value = "agent")]
        target: String,
        /// Number of lines
        #[arg(short, long, default_value = "30")]
        lines: usize,
    },

    /// Show error log lines and failed jobs
    #[command(alias = "e")]
    Errors {
        /// Service target
        #[arg(default_value = "agent")]
        target: String,
        /// Number of lines
        #[arg(short, long, default_value = "20")]
        lines: usize,
    },

    /// Follow (tail -f) log files
    #[command(alias = "f")]
    Follow {
        /// Service target
        #[arg(default_value = "agent")]
        target: String,
    },

    /// Show all managed processes
    #[command(alias = "p")]
    Ps,

    // ─── Vault Operations ────────────────────────────────────────────

    /// Vault operations (list, read, write, stats, context)
    Vault {
        /// Subcommand: list, tree, read, write, stats, context
        #[arg(default_value = "stats")]
        sub: String,
        /// Additional arguments
        args: Vec<String>,
    },

    /// Search vault notes
    Search {
        /// Search query
        query: Vec<String>,
        /// Max results
        #[arg(short, long, default_value = "20")]
        limit: usize,
    },

    /// Show/manage memory and system context
    Memory {
        /// Subcommand: show, facts, add, soul, preferences, context
        #[arg(default_value = "show")]
        sub: String,
        /// Additional arguments
        args: Vec<String>,
    },

    // ─── Jobs & Tasks ────────────────────────────────────────────────

    /// List/create/cancel jobs
    Jobs {
        /// Subcommand: list, create, cancel, show
        #[arg(default_value = "list")]
        sub: String,
        /// Additional arguments
        args: Vec<String>,
    },

    /// List/create tasks
    Tasks {
        /// Subcommand: list, create, show
        #[arg(default_value = "list")]
        sub: String,
        /// Additional arguments
        args: Vec<String>,
    },

    /// Browse cross-agent plans
    #[command(alias = "plan")]
    Plans {
        /// Subcommand: list, status, search
        #[arg(default_value = "list")]
        sub: String,
        /// Plan ID or search query
        arg: Option<String>,
    },

    // ─── Teams & Agents ──────────────────────────────────────────────

    /// List teams and run team workflows
    Teams {
        /// Subcommand: list, run
        #[arg(default_value = "list")]
        sub: String,
        /// Additional arguments
        args: Vec<String>,
    },

    /// List/inspect agent definitions
    Agents {
        /// Subcommand: list, show
        #[arg(default_value = "list")]
        sub: String,
        /// Additional arguments
        args: Vec<String>,
    },

    // ─── Configuration ───────────────────────────────────────────────

    /// Show/edit configuration
    Config {
        /// Config key to show or set
        key: Option<String>,
        /// Value to set
        value: Option<String>,
    },

    /// Install MCP server for Claude Desktop / editors
    Mcp {
        /// Subcommand: install, status, remove
        #[arg(default_value = "install")]
        sub: String,
    },

    // ─── Background Daemon ───────────────────────────────────────────

    /// Daemon management (start/stop/status/logs)
    #[command(alias = "d")]
    Daemon {
        /// Subcommand: start, stop, status, logs
        #[arg(default_value = "status")]
        sub: String,
        /// Optional argument (e.g., number of log lines)
        arg: Option<String>,
    },

    // ─── Advanced ────────────────────────────────────────────────────

    /// Force-kill all processes
    #[command(alias = "k")]
    Kill,

    /// Remove stale locks and orphans
    #[command(alias = "c")]
    Clean,

    /// Install service daemons (launchd/systemd)
    Install {
        /// Target: all, agent, relay, daemon
        #[arg(default_value = "all")]
        target: String,
    },

    /// Remove service daemons
    Uninstall {
        /// Target: all, agent, relay, daemon
        #[arg(default_value = "all")]
        target: String,
    },

    /// Check for and apply updates
    Update {
        /// Check only, don't apply
        #[arg(long)]
        check: bool,
    },

    // ─── Tools & Diagrams ────────────────────────────────────────────

    /// Check/install CLI tools (Claude, Gemini, OpenCode)
    #[command(alias = "t")]
    Tools,

    /// Generate diagrams via DrawIt
    #[command(alias = "draw")]
    Diagram {
        /// Subcommand: flow, map, deps, routes, render, create
        #[arg(default_value = "help")]
        sub: String,
        /// Additional arguments
        args: Vec<String>,
    },

    /// Run model benchmark
    Benchmark {
        /// Model to benchmark
        #[arg(short, long)]
        model: Option<String>,
    },

    // ─── Usage & Sync ────────────────────────────────────────────────

    /// Show usage statistics
    Usage {
        /// Subcommand: summary, activity
        #[arg(default_value = "summary")]
        sub: String,
    },

    /// Vault sync status
    Sync {
        /// Subcommand: status, reset
        #[arg(default_value = "status")]
        sub: String,
    },

    // ─── Web Dashboard ───────────────────────────────────────────────

    /// Open HQ web dashboard
    #[command(alias = "web", alias = "dashboard")]
    Pwa {
        /// Port to serve on
        #[arg(short, long, default_value = "4747")]
        port: u16,
    },

    /// Show version and build info
    Version,
}

#[tokio::main]
async fn main() -> Result<()> {
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let cli = Cli::parse();

    let mut config = HqConfig::load()?;
    if let Some(vault) = cli.vault {
        config.vault_path = vault.into();
    }

    // Default to Chat if no command given
    let command = cli.command.unwrap_or(Commands::Chat { model: None });

    match command {
        // Getting Started
        Commands::Init { vault_path, non_interactive } => {
            commands::init::run(vault_path, non_interactive).await
        }
        Commands::Setup => commands::setup::run().await,
        Commands::Health => commands::health::run(&config).await,
        Commands::Doctor => commands::doctor::run(&config).await,
        Commands::Env => commands::env::run(&config).await,

        // Chat & Agents
        Commands::Chat { model } => commands::chat::run(&config, model).await,
        Commands::Agent { harness } => commands::agent::run(&config, &harness).await,

        // Orchestrator
        Commands::Orchestrate { instruction, dry_run, single } => {
            let instr = instruction.join(" ");
            commands::orchestrate::run(&config, &instr, dry_run, single).await
        }

        // Services
        Commands::Status => commands::status::run(&config).await,
        Commands::Start { component } => commands::start::run(&config, &component).await,
        Commands::Stop { component } => commands::stop::run(&config, &component).await,
        Commands::Restart { component } => commands::restart::run(&config, &component).await,

        // Monitoring
        Commands::Logs { target, lines } => commands::logs::run(&config, &target, lines).await,
        Commands::Errors { target, lines } => commands::errors::run(&config, &target, lines).await,
        Commands::Follow { target } => commands::follow::run(&config, &target).await,
        Commands::Ps => commands::ps::run(&config).await,

        // Vault Operations
        Commands::Vault { sub, args } => commands::vault::run(&config, &sub, &args).await,
        Commands::Search { query, limit } => {
            let q = query.join(" ");
            commands::search::run(&config, &q, limit).await
        }
        Commands::Memory { sub, args } => commands::memory::run(&config, &sub, &args).await,

        // Jobs & Tasks
        Commands::Jobs { sub, args } => commands::jobs::run(&config, &sub, &args).await,
        Commands::Tasks { sub, args } => commands::tasks::run(&config, &sub, &args).await,
        Commands::Plans { sub, arg } => {
            commands::plans::run(&config, &sub, arg.as_deref()).await
        }

        // Teams & Agents
        Commands::Teams { sub, args } => commands::teams::run(&config, &sub, &args).await,
        Commands::Agents { sub, args } => commands::agents::run(&config, &sub, &args).await,

        // Configuration
        Commands::Config { key, value } => {
            commands::config::run(&config, key.as_deref(), value.as_deref()).await
        }
        Commands::Mcp { sub } => commands::mcp::run(&config, &sub).await,

        // Daemon
        Commands::Daemon { sub, arg } => {
            commands::daemon::run(&config, &sub, arg.as_deref()).await
        }

        // Advanced
        Commands::Kill => commands::kill::run(&config).await,
        Commands::Clean => commands::clean::run(&config).await,
        Commands::Install { target } => commands::install::run(&config, &target).await,
        Commands::Uninstall { target } => commands::uninstall::run(&config, &target).await,
        Commands::Update { check } => commands::update::run(&config, check).await,

        // Tools & Diagrams
        Commands::Tools => commands::tools::run(&config).await,
        Commands::Diagram { sub, args } => commands::diagram::run(&config, &sub, &args).await,
        Commands::Benchmark { model } => {
            commands::benchmark::run(&config, model.as_deref()).await
        }

        // Usage & Sync
        Commands::Usage { sub } => commands::usage::run(&config, &sub).await,
        Commands::Sync { sub } => commands::sync::run(&config, &sub).await,

        // Web Dashboard
        Commands::Pwa { port } => commands::pwa::run(&config, port).await,

        // Version
        Commands::Version => {
            println!("hq {} (rust)", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
    }
}
