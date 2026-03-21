//! Relay adapters — Discord and Telegram bot implementations.

pub mod discord;
pub mod telegram;

pub use discord::run_discord_relay;
pub use telegram::run_telegram_relay;
