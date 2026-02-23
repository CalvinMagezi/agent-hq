#!/bin/bash
# Install Agent HQ launchd agents for scheduled workflows.
# Usage: bash scripts/install-launchd.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
BUN_PATH="$(which bun)"

mkdir -p "$LAUNCH_AGENTS_DIR"

echo "Installing Agent HQ launchd agents..."
echo "Project: $PROJECT_DIR"
echo "Bun: $BUN_PATH"

# ─── Source API Keys ─────────────────────────────────────────────────
# Launchd does not inherit shell environment, so we must embed API keys
# into the plist files. Source from .env.local files.

source_env_file() {
  local FILE="$1"
  if [ -f "$FILE" ]; then
    # Source the file, exporting only KEY=VALUE lines (skip comments and blanks)
    while IFS='=' read -r key value; do
      # Skip comments, blank lines, and lines without =
      [[ "$key" =~ ^[[:space:]]*# ]] && continue
      [[ -z "$key" ]] && continue
      # Trim whitespace
      key="$(echo "$key" | xargs)"
      value="$(echo "$value" | xargs)"
      # Only set if not already set in environment
      if [ -z "${!key}" ] && [ -n "$value" ]; then
        export "$key=$value"
      fi
    done < "$FILE"
  fi
}

# Try app-level env first, then project root
source_env_file "$PROJECT_DIR/apps/agent/.env.local"
source_env_file "$PROJECT_DIR/.env.local"

echo ""
echo "API Key Status:"
[ -n "$OPENROUTER_API_KEY" ] && echo "  OPENROUTER_API_KEY: set" || echo "  OPENROUTER_API_KEY: NOT SET"
[ -n "$BRAVE_API_KEY" ]      && echo "  BRAVE_API_KEY:      set" || echo "  BRAVE_API_KEY:      not set (optional)"
[ -n "$GEMINI_API_KEY" ]     && echo "  GEMINI_API_KEY:     set" || echo "  GEMINI_API_KEY:     not set (optional)"
echo ""

if [ -z "$OPENROUTER_API_KEY" ]; then
  echo "WARNING: OPENROUTER_API_KEY not found in .env.local files or shell environment."
  echo "All workflows require this key. Set it in apps/agent/.env.local and re-run this script."
  exit 1
fi

# ─── Helper ───────────────────────────────────────────────────────────

install_plist() {
  local NAME="$1"
  local SCRIPT="$2"
  local HOUR="$3"
  local MINUTE="$4"
  local WEEKDAY="$5"  # Optional: 0=Sun, 1=Mon, ..., 6=Sat

  local PLIST_PATH="$LAUNCH_AGENTS_DIR/com.agent-hq.$NAME.plist"
  local LOG_PATH="$PROJECT_DIR/.vault/_logs/launchd-$NAME.log"

  local CALENDAR_INTERVAL=""
  if [ -n "$WEEKDAY" ]; then
    CALENDAR_INTERVAL="
      <key>StartCalendarInterval</key>
      <dict>
        <key>Weekday</key>
        <integer>$WEEKDAY</integer>
        <key>Hour</key>
        <integer>$HOUR</integer>
        <key>Minute</key>
        <integer>$MINUTE</integer>
      </dict>"
  else
    CALENDAR_INTERVAL="
      <key>StartCalendarInterval</key>
      <dict>
        <key>Hour</key>
        <integer>$HOUR</integer>
        <key>Minute</key>
        <integer>$MINUTE</integer>
      </dict>"
  fi

  cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agent-hq.$NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN_PATH</string>
    <string>run</string>
    <string>$SCRIPT_DIR/workflows/$SCRIPT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VAULT_PATH</key>
    <string>$PROJECT_DIR/.vault</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>OPENROUTER_API_KEY</key>
    <string>$OPENROUTER_API_KEY</string>
$([ -n "$BRAVE_API_KEY" ] && cat <<BRAVE
    <key>BRAVE_API_KEY</key>
    <string>$BRAVE_API_KEY</string>
BRAVE
)
$([ -n "$GEMINI_API_KEY" ] && cat <<GEMINI
    <key>GEMINI_API_KEY</key>
    <string>$GEMINI_API_KEY</string>
GEMINI
)
  </dict>$CALENDAR_INTERVAL
  <key>StandardOutPath</key>
  <string>$LOG_PATH</string>
  <key>StandardErrorPath</key>
  <string>$LOG_PATH</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
EOF

  # Load the agent
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"

  echo "  Installed: com.agent-hq.$NAME"
}

# ─── Service Helper (long-running KeepAlive daemons) ──────────────────

install_service_plist() {
  local NAME="$1"
  local WORK_DIR="$2"
  local ENTRY_POINT="$3"
  local EXTRA_ENV="$4"  # Optional extra env vars (pre-formatted plist XML)

  local PLIST_PATH="$LAUNCH_AGENTS_DIR/com.agent-hq.$NAME.plist"
  local LOG_PATH="$HOME/Library/Logs/agent-hq-$NAME.log"
  local ERR_PATH="$HOME/Library/Logs/agent-hq-$NAME.error.log"

  cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agent-hq.$NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN_PATH</string>
    <string>$ENTRY_POINT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$WORK_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/$USER/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>VAULT_PATH</key>
    <string>$PROJECT_DIR/.vault</string>
    <key>OPENROUTER_API_KEY</key>
    <string>$OPENROUTER_API_KEY</string>
$([ -n "$BRAVE_API_KEY" ] && cat <<BRAVE
    <key>BRAVE_API_KEY</key>
    <string>$BRAVE_API_KEY</string>
BRAVE
)
$([ -n "$GEMINI_API_KEY" ] && cat <<GEMINI
    <key>GEMINI_API_KEY</key>
    <string>$GEMINI_API_KEY</string>
GEMINI
)
$EXTRA_ENV
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$LOG_PATH</string>
  <key>StandardErrorPath</key>
  <string>$ERR_PATH</string>
</dict>
</plist>
EOF

  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"

  echo "  Installed service: com.agent-hq.$NAME (KeepAlive)"
}

# ─── Install Persistent Services ─────────────────────────────────────

echo "Installing persistent services..."

# Also source relay env for Discord tokens
source_env_file "$PROJECT_DIR/apps/discord-relay/.env.local"

# 1. Daemon — background heartbeat, health checks, embeddings
install_service_plist "daemon" "$PROJECT_DIR" "scripts/agent-hq-daemon.ts"

# 2. HQ Agent — job processing worker
AGENT_ENV="    <key>DEFAULT_MODEL</key>
    <string>${DEFAULT_MODEL:-gemini-2.5-flash}</string>"
install_service_plist "agent" "$PROJECT_DIR/apps/agent" "index.ts" "$AGENT_ENV"

# 3. Discord Relay — multi-bot relay
RELAY_ENV="    <key>DISCORD_BOT_TOKEN</key>
    <string>$DISCORD_BOT_TOKEN</string>
    <key>DISCORD_USER_ID</key>
    <string>$DISCORD_USER_ID</string>
$([ -n "$DISCORD_BOT_TOKEN_OPENCODE" ] && cat <<OC
    <key>DISCORD_BOT_TOKEN_OPENCODE</key>
    <string>$DISCORD_BOT_TOKEN_OPENCODE</string>
OC
)
$([ -n "$DISCORD_BOT_TOKEN_GEMINI" ] && cat <<GEM
    <key>DISCORD_BOT_TOKEN_GEMINI</key>
    <string>$DISCORD_BOT_TOKEN_GEMINI</string>
GEM
)
$([ -n "$GROQ_API_KEY" ] && cat <<GROQ
    <key>GROQ_API_KEY</key>
    <string>$GROQ_API_KEY</string>
    <key>VOICE_PROVIDER</key>
    <string>groq</string>
GROQ
)
    <key>USER_NAME</key>
    <string>${USER_NAME:-$(whoami)}</string>
$([ -n "$GEMINI_DEFAULT_MODEL" ] && cat <<GM
    <key>GEMINI_DEFAULT_MODEL</key>
    <string>$GEMINI_DEFAULT_MODEL</string>
GM
)"
install_service_plist "discord-relay" "$PROJECT_DIR/apps/discord-relay" "index.ts" "$RELAY_ENV"

echo ""

# ─── Install Scheduled Workflows ─────────────────────────────────────

echo "Installing scheduled workflows..."

# Daily workflows
install_plist "memory-consolidation" "memory-consolidation.ts" 3 0    # 3:00 AM
install_plist "web-digest"           "web-digest.ts"           7 0    # 7:00 AM

# Weekly workflows
install_plist "preference-tracker"   "preference-tracker.ts"   8 0 0  # Sunday 8:00 AM
install_plist "knowledge-analysis"   "knowledge-analysis.ts"   6 0 6  # Saturday 6:00 AM
install_plist "project-tracker"      "project-tracker.ts"      9 0 5  # Friday 9:00 AM
install_plist "model-tracker"        "model-tracker.ts"        9 0 1  # Monday 9:00 AM

echo ""
echo "All Agent HQ services and workflows installed."
echo ""
echo "Services (KeepAlive — auto-restart):"
echo "  com.agent-hq.daemon         — Background daemon"
echo "  com.agent-hq.agent          — HQ agent (job processing)"
echo "  com.agent-hq.discord-relay  — Discord multi-bot relay"
echo ""
echo "Logs:"
echo "  Services: ~/Library/Logs/agent-hq-*.log"
echo "  Workflows: $PROJECT_DIR/.vault/_logs/launchd-*.log"
echo ""
echo "To stop a service:   launchctl unload ~/Library/LaunchAgents/com.agent-hq.<name>.plist"
echo "To start a service:  launchctl load ~/Library/LaunchAgents/com.agent-hq.<name>.plist"
echo "To uninstall all:"
echo "  launchctl unload ~/Library/LaunchAgents/com.agent-hq.*.plist"
echo "  rm ~/Library/LaunchAgents/com.agent-hq.*.plist"
