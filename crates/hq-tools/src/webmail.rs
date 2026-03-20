//! Webmail tools — 6 tools for IMAP read + SMTP send.
//!
//! Port of the TypeScript webmail tools. These shell out to a helper binary
//! or use the `hq-webmail` helper script since native IMAP/SMTP in Rust
//! requires heavy dependencies. The tools use `tokio::process::Command` to
//! call a Python/Node helper for actual IMAP/SMTP operations.
//!
//! Credentials from env: IMAP_HOST, IMAP_USER, IMAP_PASS, SMTP_HOST, SMTP_USER, SMTP_PASS

use anyhow::{Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::process::Command;

use crate::registry::HqTool;

fn get_imap_config() -> Result<(String, String, String, u16)> {
    let host = std::env::var("IMAP_HOST")
        .map_err(|_| anyhow::anyhow!("IMAP_HOST not set"))?;
    let user = std::env::var("IMAP_USER")
        .map_err(|_| anyhow::anyhow!("IMAP_USER not set"))?;
    let pass = std::env::var("IMAP_PASS")
        .map_err(|_| anyhow::anyhow!("IMAP_PASS not set"))?;
    let port: u16 = std::env::var("IMAP_PORT")
        .unwrap_or_else(|_| "993".to_string())
        .parse()
        .unwrap_or(993);
    Ok((host, user, pass, port))
}

fn get_smtp_config() -> Result<(String, String, String, u16)> {
    let host = std::env::var("SMTP_HOST")
        .map_err(|_| anyhow::anyhow!("SMTP_HOST not set"))?;
    let user = std::env::var("SMTP_USER")
        .map_err(|_| anyhow::anyhow!("SMTP_USER not set"))?;
    let pass = std::env::var("SMTP_PASS")
        .map_err(|_| anyhow::anyhow!("SMTP_PASS not set"))?;
    let port: u16 = std::env::var("SMTP_PORT")
        .unwrap_or_else(|_| "465".to_string())
        .parse()
        .unwrap_or(465);
    Ok((host, user, pass, port))
}

fn account_label() -> String {
    std::env::var("MAIL_ACCOUNT_LABEL")
        .or_else(|_| std::env::var("IMAP_USER"))
        .unwrap_or_else(|_| "email".to_string())
}

/// Run the webmail helper script. The helper is expected to be at
/// `packages/webmail-mcp/dist/cli.js` or available as `hq-webmail` in PATH.
async fn run_webmail_helper(action: &str, args_json: &Value) -> Result<Value> {
    // Try node helper first
    let helper_paths = [
        "hq-webmail",
        "node",
    ];

    let json_str = serde_json::to_string(args_json)?;

    for helper in &helper_paths {
        let mut cmd_args: Vec<String> = Vec::new();
        if *helper == "node" {
            // Try to find the helper script
            if let Ok(home) = std::env::var("HOME") {
                let script = format!("{home}/.agent-hq/webmail-helper.js");
                if tokio::fs::try_exists(&script).await.unwrap_or(false) {
                    cmd_args.push(script);
                } else {
                    continue;
                }
            } else {
                continue;
            }
        }
        cmd_args.push(action.to_string());
        cmd_args.push(json_str.clone());

        let output = Command::new(helper)
            .args(&cmd_args)
            .output()
            .await;

        match output {
            Ok(o) if o.status.success() => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                return serde_json::from_str(stdout.trim())
                    .map_err(|e| anyhow::anyhow!("Failed to parse helper output: {e}\nOutput: {stdout}"));
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                tracing::warn!("[webmail] {helper} {action} failed: {stderr}");
            }
            Err(_) => continue,
        }
    }

    bail!("Webmail helper not available. Install hq-webmail or set up ~/.agent-hq/webmail-helper.js")
}

// ─── mail_status ────────────────────────────────────────────────

pub struct MailStatusTool;

impl MailStatusTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MailStatusTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HqTool for MailStatusTool {
    fn name(&self) -> &str {
        "mail_status"
    }

    fn description(&self) -> &str {
        "Get mailbox status — total messages, unread count for a folder."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "folder": { "type": "string", "description": "Mailbox folder (default: INBOX)" }
            }
        })
    }

    fn category(&self) -> &str {
        "email"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let (host, user, pass, port) = get_imap_config()?;
        let folder = args.get("folder").and_then(|v| v.as_str()).unwrap_or("INBOX");
        run_webmail_helper("status", &json!({
            "host": host, "user": user, "pass": pass, "port": port,
            "folder": folder,
        })).await
    }
}

// ─── mail_list ──────────────────────────────────────────────────

pub struct MailListTool;

impl MailListTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MailListTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HqTool for MailListTool {
    fn name(&self) -> &str {
        "mail_list"
    }

    fn description(&self) -> &str {
        "List email headers from a mailbox folder — subject, from, date, flags. Newest first."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "folder": { "type": "string", "description": "Mailbox folder (default: INBOX)" },
                "limit": { "type": "integer", "description": "Max emails (default: 20, max: 50)" },
                "offset": { "type": "integer", "description": "Skip N most recent (pagination)" },
                "unread_only": { "type": "boolean", "description": "Only unread emails" }
            }
        })
    }

    fn category(&self) -> &str {
        "email"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let (host, user, pass, port) = get_imap_config()?;
        let folder = args.get("folder").and_then(|v| v.as_str()).unwrap_or("INBOX");
        let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20).min(50);
        let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
        let unread_only = args.get("unread_only").and_then(|v| v.as_bool()).unwrap_or(false);

        run_webmail_helper("list", &json!({
            "host": host, "user": user, "pass": pass, "port": port,
            "folder": folder, "limit": limit, "offset": offset, "unreadOnly": unread_only,
        })).await
    }
}

// ─── mail_read ──────────────────────────────────────────────────

pub struct MailReadTool;

impl MailReadTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MailReadTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HqTool for MailReadTool {
    fn name(&self) -> &str {
        "mail_read"
    }

    fn description(&self) -> &str {
        "Read full email by UID — body text, attachments, headers."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "uid": { "type": "integer", "description": "Email UID" },
                "folder": { "type": "string", "description": "Mailbox folder (default: INBOX)" }
            },
            "required": ["uid"]
        })
    }

    fn category(&self) -> &str {
        "email"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let (host, user, pass, port) = get_imap_config()?;
        let uid = args.get("uid").and_then(|v| v.as_u64()).unwrap_or(0);
        let folder = args.get("folder").and_then(|v| v.as_str()).unwrap_or("INBOX");

        run_webmail_helper("read", &json!({
            "host": host, "user": user, "pass": pass, "port": port,
            "uid": uid, "folder": folder,
        })).await
    }
}

// ─── mail_search ────────────────────────────────────────────────

pub struct MailSearchTool;

impl MailSearchTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MailSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HqTool for MailSearchTool {
    fn name(&self) -> &str {
        "mail_search"
    }

    fn description(&self) -> &str {
        "Search emails by sender, subject, body, date range, or unread status."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "from": { "type": "string", "description": "Filter by sender" },
                "to": { "type": "string", "description": "Filter by recipient" },
                "subject": { "type": "string", "description": "Search in subject" },
                "body": { "type": "string", "description": "Search in body" },
                "since": { "type": "string", "description": "Emails after date (ISO 8601)" },
                "before": { "type": "string", "description": "Emails before date" },
                "unseen": { "type": "boolean", "description": "Only unread" },
                "folder": { "type": "string", "description": "Mailbox folder (default: INBOX)" },
                "limit": { "type": "integer", "description": "Max results (default: 20)" }
            }
        })
    }

    fn category(&self) -> &str {
        "email"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let (host, user, pass, port) = get_imap_config()?;
        let mut search_args = json!({
            "host": host, "user": user, "pass": pass, "port": port,
        });
        // Forward all search params
        for key in &["from", "to", "subject", "body", "since", "before", "unseen", "folder", "limit"] {
            if let Some(v) = args.get(*key) {
                search_args[*key] = v.clone();
            }
        }
        run_webmail_helper("search", &search_args).await
    }
}

// ─── mail_send ──────────────────────────────────────────────────

pub struct MailSendTool;

impl MailSendTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MailSendTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HqTool for MailSendTool {
    fn name(&self) -> &str {
        "mail_send"
    }

    fn description(&self) -> &str {
        "Send an email via SMTP — plain text or HTML, CC/BCC, reply threading."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "to": { "type": "string", "description": "Recipient(s), comma-separated" },
                "subject": { "type": "string", "description": "Subject line" },
                "text": { "type": "string", "description": "Plain text body" },
                "html": { "type": "string", "description": "HTML body" },
                "cc": { "type": "string", "description": "CC recipients" },
                "bcc": { "type": "string", "description": "BCC recipients" },
                "reply_to": { "type": "string", "description": "Reply-To address" },
                "in_reply_to": { "type": "string", "description": "Message-ID for threading" },
                "references": { "type": "string", "description": "References header" }
            },
            "required": ["to", "subject"]
        })
    }

    fn category(&self) -> &str {
        "email"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let (host, user, pass, port) = get_smtp_config()?;
        let text = args.get("text").and_then(|v| v.as_str());
        let html = args.get("html").and_then(|v| v.as_str());
        if text.is_none() && html.is_none() {
            bail!("Either text or html body is required");
        }

        let mut send_args = json!({
            "host": host, "user": user, "pass": pass, "port": port,
            "fromName": std::env::var("MAIL_FROM_NAME").unwrap_or_default(),
        });
        for key in &["to", "subject", "text", "html", "cc", "bcc", "reply_to", "in_reply_to", "references"] {
            if let Some(v) = args.get(*key) {
                send_args[*key] = v.clone();
            }
        }
        run_webmail_helper("send", &send_args).await
    }
}

// ─── mail_folders ───────────────────────────────────────────────

pub struct MailFoldersTool;

impl MailFoldersTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MailFoldersTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HqTool for MailFoldersTool {
    fn name(&self) -> &str {
        "mail_folders"
    }

    fn description(&self) -> &str {
        "List all mailbox folders (INBOX, Sent, Drafts, etc.)"
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {}
        })
    }

    fn category(&self) -> &str {
        "email"
    }

    async fn execute(&self, _args: Value) -> Result<Value> {
        let (host, user, pass, port) = get_imap_config()?;
        run_webmail_helper("folders", &json!({
            "host": host, "user": user, "pass": pass, "port": port,
        })).await
    }
}

/// All webmail tools for batch registration.
pub fn webmail_tools() -> Vec<Box<dyn HqTool>> {
    vec![
        Box::new(MailStatusTool::new()),
        Box::new(MailListTool::new()),
        Box::new(MailReadTool::new()),
        Box::new(MailSearchTool::new()),
        Box::new(MailSendTool::new()),
        Box::new(MailFoldersTool::new()),
    ]
}
