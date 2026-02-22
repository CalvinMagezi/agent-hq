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

# ─── Install All Workflows ────────────────────────────────────────────

# Daily workflows
install_plist "memory-consolidation" "memory-consolidation.ts" 3 0    # 3:00 AM
install_plist "web-digest"           "web-digest.ts"           7 0    # 7:00 AM

# Weekly workflows
install_plist "preference-tracker"   "preference-tracker.ts"   8 0 0  # Sunday 8:00 AM
install_plist "knowledge-analysis"   "knowledge-analysis.ts"   6 0 6  # Saturday 6:00 AM
install_plist "project-tracker"      "project-tracker.ts"      9 0 5  # Friday 9:00 AM
install_plist "model-tracker"        "model-tracker.ts"        9 0 1  # Monday 9:00 AM

echo ""
echo "All Agent HQ launchd agents installed."
echo "View logs at: $PROJECT_DIR/.vault/_logs/launchd-*.log"
echo ""
echo "To uninstall all agents:"
echo "  launchctl unload ~/Library/LaunchAgents/com.agent-hq.*.plist"
echo "  rm ~/Library/LaunchAgents/com.agent-hq.*.plist"
