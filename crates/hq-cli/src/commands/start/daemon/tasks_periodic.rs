//! Periodic daemon tasks (5 min — 1 hour intervals).

use anyhow::Result;
use hq_core::config::HqConfig;
use hq_db::Database;
use std::path::Path;
use tracing::info;

use super::helpers::*;

/// Update HEARTBEAT.md with daemon status.
pub async fn run_heartbeat(vault_path: &Path) -> Result<()> {
    let sys_dir = vault_path.join("_system");
    ensure_dir(&sys_dir);
    let now = chrono::Utc::now().to_rfc3339();
    let uptime_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let content = format!(
        "---\nstatus: alive\nlast_heartbeat: {now}\nruntime: rust\n---\n\n\
         # Heartbeat\n\nDaemon is alive.\n\n\
         - **Last heartbeat**: {now}\n\
         - **System uptime**: {}h {}m\n\
         - **Components**: daemon, agent-worker\n",
        uptime_secs / 3600,
        (uptime_secs % 3600) / 60
    );
    std::fs::write(sys_dir.join("HEARTBEAT.md"), content)?;
    Ok(())
}

/// Check for stuck jobs (>30min), stale heartbeat.
pub async fn run_health_check(vault_path: &Path) -> Result<()> {
    let running_dir = vault_path.join("_jobs").join("running");
    if running_dir.exists() {
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(1800);
        if let Ok(entries) = std::fs::read_dir(&running_dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified < cutoff {
                            tracing::warn!(
                                job = ?entry.file_name(),
                                "health-check: stuck job detected (running > 30min)"
                            );
                        }
                    }
                }
            }
        }
    }
    // Check worker heartbeat
    let heartbeat_path = vault_path.join("_system").join("HEARTBEAT.md");
    if heartbeat_path.exists() {
        if let Ok(meta) = std::fs::metadata(&heartbeat_path) {
            if let Ok(modified) = meta.modified() {
                let age = std::time::SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or_default();
                if age > std::time::Duration::from_secs(300) {
                    tracing::warn!(
                        age_secs = age.as_secs(),
                        "health-check: heartbeat is stale (> 5min old)"
                    );
                }
            }
        }
    }
    Ok(())
}

/// Ping browser health endpoint.
pub async fn run_browser_health() -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()?;
    match client
        .get("http://127.0.0.1:19200/health")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            tracing::debug!("browser-health: browser server is up");
        }
        Ok(resp) => {
            tracing::warn!(
                status = %resp.status(),
                "browser-health: browser server returned non-200"
            );
        }
        Err(e) => {
            tracing::debug!(
                error = %e,
                "browser-health: browser server is down (expected if not running)"
            );
        }
    }
    Ok(())
}

/// Fetch RSS feeds and write NEWS-PULSE.md.
pub async fn run_news_pulse(vault_path: &Path) -> Result<()> {
    let sys_dir = vault_path.join("_system");
    ensure_dir(&sys_dir);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let feeds = [
        ("Hacker News", "https://hnrss.org/frontpage?count=10"),
        ("TechCrunch", "https://techcrunch.com/feed/"),
        ("The Guardian Tech", "https://www.theguardian.com/technology/rss"),
        ("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"),
        ("TechCabal (Africa)", "https://techcabal.com/feed/"),
    ];

    let now = chrono::Utc::now().to_rfc3339();
    let mut md = format!("---\nupdated_at: {now}\n---\n\n# News Pulse\n\nUpdated: {now}\n\n");

    for (name, url) in &feeds {
        md.push_str(&format!("## {name}\n\n"));
        match client.get(*url).send().await {
            Ok(resp) => {
                if let Ok(body) = resp.text().await {
                    parse_rss_items(&body, &mut md, 10);
                }
            }
            Err(e) => {
                md.push_str(&format!("- *fetch error: {e}*\n"));
            }
        }
        md.push('\n');
    }

    std::fs::write(sys_dir.join("NEWS-PULSE.md"), md)?;
    info!("news-pulse: updated NEWS-PULSE.md");
    Ok(())
}

/// Parse RSS (<item>) and Atom (<entry>) feed formats.
fn parse_rss_items(body: &str, md: &mut String, max_items: usize) {
    let mut found = 0;

    // Try RSS format first (<item>)
    found += parse_xml_items(body, md, max_items, "<item", "</item>");

    // If RSS found nothing, try Atom format (<entry>)
    if found == 0 {
        found += parse_xml_items(body, md, max_items, "<entry", "</entry>");
    }

    if found == 0 {
        md.push_str("- *(no items parsed)*\n");
    }
}

fn parse_xml_items(
    body: &str,
    md: &mut String,
    max_items: usize,
    open_tag: &str,
    _close_tag: &str,
) -> usize {
    let mut count = 0;
    for (i, item_chunk) in body.split(open_tag).enumerate() {
        if i == 0 {
            continue; // skip preamble
        }
        if count >= max_items {
            break;
        }

        // Extract title
        let title = extract_xml_field(item_chunk, "title");
        if title.is_empty() {
            continue;
        }

        // Extract link — try multiple formats:
        // RSS: <link>url</link>
        // Atom: <link href="url"/>  or  <link href="url" rel="alternate"/>
        let link = extract_link(item_chunk);

        if !link.is_empty() {
            md.push_str(&format!("- [{}]({})\n", title.trim(), link.trim()));
        } else {
            md.push_str(&format!("- {}\n", title.trim()));
        }
        count += 1;
    }
    count
}

fn extract_xml_field(chunk: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    if let Some(start) = chunk.find(&open) {
        if let Some(end) = chunk[start..].find(&close) {
            let raw = &chunk[start + open.len()..start + end];
            return raw
                .replace("<![CDATA[", "")
                .replace("]]>", "")
                .trim()
                .to_string();
        }
    }
    String::new()
}

fn extract_link(chunk: &str) -> String {
    // Try RSS style: <link>url</link>
    let rss_link = extract_xml_field(chunk, "link");
    if !rss_link.is_empty() && rss_link.starts_with("http") {
        return rss_link;
    }

    // Try Atom style: <link href="url"
    if let Some(link_start) = chunk.find("<link") {
        let after = &chunk[link_start..];
        if let Some(href_start) = after.find("href=\"") {
            let url_start = href_start + 6;
            if let Some(href_end) = after[url_start..].find('"') {
                return after[url_start..url_start + href_end].to_string();
            }
        }
        // Also try href='url'
        if let Some(href_start) = after.find("href='") {
            let url_start = href_start + 6;
            if let Some(href_end) = after[url_start..].find('\'') {
                return after[url_start..url_start + href_end].to_string();
            }
        }
    }

    rss_link
}

/// Run the full memory maintenance cycle: consolidation → deltas → forgetting.
/// Delegates to the real implementation in hq-daemon which uses hq-memory internally.
pub async fn run_memory_consolidation(vault_path: &Path, db: &Database) -> Result<()> {
    let vault_path_buf = vault_path.to_path_buf();
    match hq_daemon::run_memory_cycle(db, &vault_path_buf).await {
        Ok(()) => {
            tracing::debug!("memory-consolidation: cycle complete");
        }
        Err(e) => {
            // Don't propagate — Ollama being offline is expected
            tracing::debug!(error = %e, "memory-consolidation: cycle skipped or failed");
        }
    }
    Ok(())
}

/// Index unindexed notes into FTS5 for full-text search, and queue for embedding.
/// Processes up to 50 notes per cycle (FTS5 indexing is fast — no API call needed).
pub async fn run_embeddings(vault_path: &Path, db: &Database) -> Result<()> {
    let notebooks_dir = vault_path.join("Notebooks");
    if !notebooks_dir.exists() {
        return Ok(());
    }

    // Get already-indexed paths from FTS5 (as HashSet for O(1) lookup)
    let indexed_paths: std::collections::HashSet<String> = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT path FROM notes_fts")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            let mut paths = std::collections::HashSet::new();
            for row in rows {
                paths.insert(row?);
            }
            Ok(paths)
        })
        .unwrap_or_default();

    // Walk for unindexed notes (batch of 50 — FTS is cheap)
    let mut pending = Vec::new();
    walk_for_unembedded(&notebooks_dir, &indexed_paths, &mut pending, 50);

    if pending.is_empty() {
        return Ok(());
    }

    // Index each note into FTS5
    let mut indexed = 0u32;
    for path in &pending {
        if let Ok(content) = std::fs::read_to_string(path) {
            let path_str = path.to_string_lossy().to_string();
            let title = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string();

            // Extract tags from frontmatter if present
            let tags = extract_tags_from_frontmatter(&content);

            // Strip frontmatter from content for indexing
            let body = strip_frontmatter(&content);

            match db.with_conn(|conn| {
                hq_db::search::index_note(conn, &path_str, &title, &body, &tags)
            }) {
                Ok(()) => indexed += 1,
                Err(e) => {
                    tracing::debug!(
                        path = %path_str,
                        error = %e,
                        "embeddings: failed to index note"
                    );
                }
            }
        }
    }

    if indexed > 0 {
        info!(indexed, total_pending = pending.len(), "embeddings: indexed notes into FTS5");
    }

    Ok(())
}

fn extract_tags_from_frontmatter(content: &str) -> String {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return String::new();
    }
    if let Some(end_idx) = trimmed[3..].find("\n---") {
        let fm = &trimmed[3..3 + end_idx];
        let mut tags = Vec::new();
        let mut in_tags = false;
        for line in fm.lines() {
            let line = line.trim();
            if line.starts_with("tags:") {
                in_tags = true;
                // Inline tags: tags: [a, b, c]
                if line.contains('[') {
                    let inner = line
                        .split('[')
                        .nth(1)
                        .unwrap_or("")
                        .split(']')
                        .next()
                        .unwrap_or("");
                    for tag in inner.split(',') {
                        let t = tag.trim().trim_matches('"').trim_matches('\'');
                        if !t.is_empty() {
                            tags.push(t.to_string());
                        }
                    }
                    in_tags = false;
                }
                continue;
            }
            if in_tags && line.starts_with("- ") {
                let tag = line[2..].trim().trim_matches('"').trim_matches('\'');
                if !tag.is_empty() {
                    tags.push(tag.to_string());
                }
            } else if in_tags && !line.starts_with('-') {
                in_tags = false;
            }
        }
        tags.join(", ")
    } else {
        String::new()
    }
}

fn strip_frontmatter(content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.starts_with("---") {
        if let Some(end_idx) = trimmed[3..].find("\n---") {
            return trimmed[3 + end_idx + 4..].trim().to_string();
        }
    }
    content.to_string()
}

fn walk_for_unembedded(
    dir: &Path,
    embedded: &std::collections::HashSet<String>,
    pending: &mut Vec<std::path::PathBuf>,
    limit: usize,
) {
    if pending.len() >= limit {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if pending.len() >= limit {
                return;
            }
            let path = entry.path();
            if path.is_dir() {
                walk_for_unembedded(&path, embedded, pending, limit);
            } else if path.extension().is_some_and(|e| e == "md") {
                let path_str = path.to_string_lossy().to_string();
                if !embedded.contains(&path_str) {
                    pending.push(path);
                }
            }
        }
    }
}

/// Count pending jobs in inbox.
pub async fn run_inbox_scan(vault_path: &Path) -> Result<()> {
    let pending_dir = vault_path.join("_jobs").join("pending");
    if pending_dir.exists() {
        let count = std::fs::read_dir(&pending_dir)
            .map(|entries| entries.count())
            .unwrap_or(0);
        if count > 0 {
            info!(count, "hq-inbox-scan: pending jobs in inbox");
        } else {
            tracing::debug!("hq-inbox-scan: inbox empty");
        }
    }
    Ok(())
}

/// Reset monthly budget on the 1st.
pub async fn run_budget_reset(vault_path: &Path) -> Result<()> {
    use chrono::Datelike;
    let today = chrono::Utc::now();
    if today.day() == 1 && !has_run_today(vault_path, "budget-reset") {
        let usage_dir = vault_path.join("_usage");
        ensure_dir(&usage_dir);
        let now = today.to_rfc3339();
        let content = format!(
            "---\nreset_at: {now}\nmonth: {}\nmonthly_spend: 0.0\nmonthly_limit: 50.0\n---\n\n\
             # Budget\n\nMonthly budget reset on {now}\n",
            today.format("%Y-%m")
        );
        std::fs::write(usage_dir.join("budget.md"), content)?;
        mark_run_today(vault_path, "budget-reset");
        info!("budget-reset: monthly budget counters reset");
    }
    Ok(())
}

/// Move stale running jobs (>7 days) to failed/.
/// Move stale running jobs (>3 days) to failed/. Only processes .md files.
pub async fn run_stale_cleanup(vault_path: &Path) -> Result<()> {
    let running_dir = vault_path.join("_jobs").join("running");
    let failed_dir = vault_path.join("_jobs").join("failed");
    if running_dir.exists() {
        ensure_dir(&failed_dir);
        let cutoff =
            std::time::SystemTime::now() - std::time::Duration::from_secs(3 * 86400);
        if let Ok(entries) = std::fs::read_dir(&running_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.extension().is_some_and(|e| e == "md") {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified < cutoff {
                            let dest = failed_dir.join(entry.file_name());
                            let _ = std::fs::rename(entry.path(), &dest);
                            info!(
                                job = ?entry.file_name(),
                                "stale-cleanup: moved stale job to failed/"
                            );
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// Clean up old delegation files (>3 days).
pub async fn run_delegation_cleanup(vault_path: &Path) -> Result<()> {
    let completed_dir = vault_path.join("_delegation").join("completed");
    if completed_dir.exists() {
        let cutoff =
            std::time::SystemTime::now() - std::time::Duration::from_secs(3 * 86400);
        let mut removed = 0u32;
        if let Ok(entries) = std::fs::read_dir(&completed_dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified < cutoff {
                            let _ = std::fs::remove_file(entry.path());
                            removed += 1;
                        }
                    }
                }
            }
        }
        if removed > 0 {
            info!(
                count = removed,
                "delegation-cleanup: removed old delegation files"
            );
        }
    }
    Ok(())
}

/// Check OpenRouter models for intelligence updates.
/// Proactive notification check — alerts user about important events.
/// Reads CHANNEL-PRESENCE.md to determine where to send notifications.
/// Rate-limited: max 1 notification per 30 minutes.
pub async fn run_proactive_check(vault_path: &Path, config: &HqConfig) -> Result<()> {
    let sys_dir = vault_path.join("_system");
    let presence_path = sys_dir.join("CHANNEL-PRESENCE.md");
    let rate_limit_path = sys_dir.join(".last-proactive-notification");

    // Rate limit: skip if notified within last 30 minutes
    if rate_limit_path.exists() {
        if let Ok(meta) = std::fs::metadata(&rate_limit_path) {
            if let Ok(modified) = meta.modified() {
                let age = std::time::SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or_default();
                if age < std::time::Duration::from_secs(1800) {
                    return Ok(());
                }
            }
        }
    }

    // Gather alerts
    let mut alerts = Vec::new();

    // Check for stuck jobs (>30 min) — only .md files
    let running_dir = vault_path.join("_jobs").join("running");
    if running_dir.exists() {
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(1800);
        if let Ok(entries) = std::fs::read_dir(&running_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.extension().is_some_and(|e| e == "md") {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified < cutoff {
                            let age_min = std::time::SystemTime::now()
                                .duration_since(modified)
                                .unwrap_or_default()
                                .as_secs()
                                / 60;
                            alerts.push(format!(
                                "Stuck job: {} (running {}min)",
                                entry.file_name().to_string_lossy(),
                                age_min
                            ));
                        }
                    }
                }
            }
        }
    }

    // Check for unclaimed pending jobs (>10 min) — only .md files
    let pending_dir = vault_path.join("_jobs").join("pending");
    if pending_dir.exists() {
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        if let Ok(entries) = std::fs::read_dir(&pending_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.extension().is_some_and(|e| e == "md") {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified < cutoff {
                            alerts.push(format!(
                                "Unclaimed job: {}",
                                entry.file_name().to_string_lossy()
                            ));
                        }
                    }
                }
            }
        }
    }

    if alerts.is_empty() {
        return Ok(());
    }

    // Read channel presence and try to send notification
    let presence = std::fs::read_to_string(&presence_path).unwrap_or_default();
    let message = format!(
        "HQ Alert ({} issue{}):\n{}",
        alerts.len(),
        if alerts.len() == 1 { "" } else { "s" },
        alerts.iter().map(|a| format!("• {a}")).collect::<Vec<_>>().join("\n")
    );

    if let Some(ref token) = config.relay.telegram_token {
        if let Some(chat_id) = extract_presence_chat_id(&presence, "telegram") {
            let bot = teloxide::prelude::Bot::new(token);
            use teloxide::prelude::Requester;
            let chat = teloxide::types::ChatId(chat_id);
            match bot.send_message(chat, &message).await {
                Ok(_) => {
                    info!(alerts = alerts.len(), "proactive-check: sent alert to Telegram");
                    let _ = std::fs::write(&rate_limit_path, "notified");
                }
                Err(e) => {
                    tracing::debug!(error = %e, "proactive-check: Telegram send failed");
                }
            }
        }
    }

    Ok(())
}

fn extract_presence_chat_id(content: &str, platform: &str) -> Option<i64> {
    let mut found_platform = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("platform:") && line.contains(platform) {
            found_platform = true;
        }
        if found_platform && line.starts_with("chat_id:") {
            return line["chat_id:".len()..].trim().parse().ok();
        }
    }
    None
}

pub async fn run_model_intelligence(vault_path: &Path, config: &HqConfig) -> Result<()> {
    if let Some(ref api_key) = config.openrouter_api_key {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()?;
        match client
            .get("https://openrouter.ai/api/v1/models")
            .header("Authorization", format!("Bearer {api_key}"))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(body) = resp.text().await {
                    let model_count = body.matches("\"id\"").count();
                    let sys_dir = vault_path.join("_system");
                    ensure_dir(&sys_dir);
                    let now = chrono::Utc::now().to_rfc3339();
                    let content = format!(
                        "---\nupdated_at: {now}\nmodel_count: {model_count}\n---\n\n\
                         # Model Intelligence\n\nLast checked: {now}  \nModels available: {model_count}\n"
                    );
                    let _ = std::fs::write(sys_dir.join("MODEL-INTELLIGENCE.md"), content);
                    tracing::debug!(model_count, "model-intelligence: checked OpenRouter models");
                }
            }
            Ok(resp) => {
                tracing::debug!(
                    status = %resp.status(),
                    "model-intelligence: OpenRouter returned non-200"
                );
            }
            Err(e) => {
                tracing::debug!(error = %e, "model-intelligence: failed to reach OpenRouter");
            }
        }
    }
    Ok(())
}
