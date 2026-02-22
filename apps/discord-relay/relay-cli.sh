#!/bin/bash
# Source this file in your .zshrc: source ~/Documents/GitHub/agent-hq/apps/discord-relay/relay-cli.sh

RELAY_DIR="$HOME/Documents/GitHub/agent-hq/apps/discord-relay"
DAEMON_NAME="com.agent-hq.discord-relay"
LOG_FILE="$HOME/Library/Logs/discord-relay.log"
ERR_FILE="$HOME/Library/Logs/discord-relay.error.log"
LOCK_FILE="$RELAY_DIR/.discord-relay/bot.lock"

# Get relay PID from lock file or launchd or pgrep
_relay_pid() {
  # 1. Lock file (most reliable)
  if [ -f "$LOCK_FILE" ]; then
    local pid=$(cat "$LOCK_FILE" 2>/dev/null)
    if kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  # 2. launchd
  local pid=$(launchctl list 2>/dev/null | grep "$DAEMON_NAME" | awk '{print $1}')
  if [ -n "$pid" ] && [ "$pid" != "-" ] && kill -0 "$pid" 2>/dev/null; then
    echo "$pid"
    return 0
  fi
  # 3. pgrep fallback
  pgrep -f "bun.*index.ts" 2>/dev/null | head -1
}

# Main command
relay() {
  case "${1:-help}" in
    status|s)
      local pid=$(_relay_pid)
      if [ -n "$pid" ]; then
        local uptime=$(ps -o etime= -p "$pid" 2>/dev/null | xargs)
        echo "✅ Relay running (PID: $pid, uptime: $uptime)"
      else
        echo "❌ Relay not running"
      fi
      ;;

    start)
      # Check if already running
      local pid=$(_relay_pid)
      if [ -n "$pid" ]; then
        echo "⚠️  Relay already running (PID: $pid). Use 'relay restart' to restart."
        return 0
      fi
      launchctl start "$DAEMON_NAME" 2>/dev/null
      sleep 2
      relay status
      ;;

    stop)
      local pid=$(_relay_pid)
      launchctl stop "$DAEMON_NAME" 2>/dev/null
      [ -n "$pid" ] && kill "$pid" 2>/dev/null
      sleep 1
      echo "⏹️  Relay stopped"
      ;;

    restart|r)
      echo "Stopping..."
      local pid=$(_relay_pid)
      launchctl stop "$DAEMON_NAME" 2>/dev/null
      [ -n "$pid" ] && kill "$pid" 2>/dev/null
      sleep 2
      # Clean stale lock if needed
      if [ -f "$LOCK_FILE" ]; then
        LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
        if ! kill -0 "$LOCK_PID" 2>/dev/null; then
          rm -f "$LOCK_FILE"
          echo "🔓 Cleaned stale lock (PID $LOCK_PID)"
        fi
      fi
      echo "Starting..."
      launchctl start "$DAEMON_NAME" 2>/dev/null
      sleep 3
      relay status
      ;;

    install)
      "$RELAY_DIR/daemon.sh" install
      ;;

    uninstall)
      "$RELAY_DIR/daemon.sh" uninstall
      ;;

    logs|l)
      local LINES="${2:-30}"
      echo "━━━ Relay Logs (last $LINES lines) ━━━"
      tail -"$LINES" "$LOG_FILE" 2>/dev/null || echo "(no logs yet)"
      ;;

    errors|e)
      local LINES="${2:-20}"
      echo "━━━ Error Logs (last $LINES lines) ━━━"
      tail -"$LINES" "$ERR_FILE" 2>/dev/null || echo "(no errors)"
      ;;

    follow|f)
      echo "━━━ Following relay logs (Ctrl+C to stop) ━━━"
      tail -f "$LOG_FILE" 2>/dev/null
      ;;

    fg)
      echo "Starting relay in foreground (Ctrl+C to stop)..."
      local fg_pid=$(_relay_pid)
      launchctl stop "$DAEMON_NAME" 2>/dev/null
      [ -n "$fg_pid" ] && kill "$fg_pid" 2>/dev/null
      sleep 1
      cd "$RELAY_DIR" && bun index.ts
      ;;

    ps|p)
      echo "━━━ Relay Processes ━━━"
      echo ""
      # Main relay process
      local relay_pid=$(_relay_pid)
      if [ -n "$relay_pid" ]; then
        local uptime=$(ps -o etime= -p "$relay_pid" 2>/dev/null | xargs)
        echo "📡 Relay: PID $relay_pid (uptime: $uptime)"
      else
        echo "📡 Relay: not running"
      fi
      echo ""
      # Claude CLI child processes
      local CLAUDE_PROCS=$(pgrep -f "claude.*--resume\|claude.*--print\|claude.*--output-format" 2>/dev/null)
      if [ -n "$CLAUDE_PROCS" ]; then
        echo "🟣 Claude Code CLIs:"
        for pid in $CLAUDE_PROCS; do
          local uptime=$(ps -o etime= -p "$pid" 2>/dev/null | xargs)
          local cmd=$(ps -o command= -p "$pid" 2>/dev/null | head -c 80)
          echo "   PID $pid ($uptime) $cmd"
        done
      else
        echo "🟣 Claude Code CLIs: none"
      fi
      echo ""
      # OpenCode child processes
      local OC_PROCS=$(pgrep -f "opencode run" 2>/dev/null)
      if [ -n "$OC_PROCS" ]; then
        echo "🟢 OpenCode CLIs:"
        for pid in $OC_PROCS; do
          local uptime=$(ps -o etime= -p "$pid" 2>/dev/null | xargs)
          echo "   PID $pid ($uptime)"
        done
      else
        echo "🟢 OpenCode CLIs: none"
      fi
      echo ""
      # Gemini child processes
      local GEM_PROCS=$(pgrep -f "gemini.*--output-format\|gemini.*--yolo" 2>/dev/null)
      if [ -n "$GEM_PROCS" ]; then
        echo "🔵 Gemini CLIs:"
        for pid in $GEM_PROCS; do
          local uptime=$(ps -o etime= -p "$pid" 2>/dev/null | xargs)
          echo "   PID $pid ($uptime)"
        done
      else
        echo "🔵 Gemini CLIs: none"
      fi
      echo ""
      # Lock file
      if [ -f "$LOCK_FILE" ]; then
        local LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
        if kill -0 "$LOCK_PID" 2>/dev/null; then
          echo "🔒 Lock: PID $LOCK_PID (active)"
        else
          echo "⚠️  Lock: PID $LOCK_PID (STALE — use 'relay clean' to fix)"
        fi
      else
        echo "🔓 Lock: none"
      fi
      ;;

    kill|k)
      echo "☠️  Killing all relay processes..."
      local kill_pid=$(_relay_pid)
      [ -n "$kill_pid" ] && kill -9 "$kill_pid" 2>/dev/null
      pkill -9 -f "claude.*--resume\|claude.*--print\|claude.*--output-format" 2>/dev/null
      pkill -9 -f "opencode run" 2>/dev/null
      pkill -9 -f "gemini.*--output-format\|gemini.*--yolo" 2>/dev/null
      sleep 1
      # Clean lock
      if [ -f "$LOCK_FILE" ]; then
        rm -f "$LOCK_FILE"
        echo "🔓 Lock file removed"
      fi
      echo "Done. All relay processes killed."
      ;;

    clean|c)
      echo "━━━ Cleaning stale state ━━━"
      # Stale lock
      if [ -f "$LOCK_FILE" ]; then
        local LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
        if kill -0 "$LOCK_PID" 2>/dev/null; then
          echo "🔒 Lock is held by active PID $LOCK_PID — skipping"
        else
          rm -f "$LOCK_FILE"
          echo "🔓 Removed stale lock (PID $LOCK_PID)"
        fi
      else
        echo "🔓 No lock file"
      fi
      # Orphaned CLI processes (running without a relay parent)
      local ORPHANS=0
      for pid in $(pgrep -f "claude.*--resume\|claude.*--output-format" 2>/dev/null); do
        local ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | xargs)
        if ! pgrep -f "bun.*discord-relay" | grep -q "$ppid"; then
          echo "☠️  Killing orphaned Claude CLI (PID $pid, parent $ppid)"
          kill -9 "$pid" 2>/dev/null
          ORPHANS=$((ORPHANS + 1))
        fi
      done
      for pid in $(pgrep -f "opencode run" 2>/dev/null); do
        local ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | xargs)
        if ! pgrep -f "bun.*discord-relay" | grep -q "$ppid"; then
          echo "☠️  Killing orphaned OpenCode CLI (PID $pid, parent $ppid)"
          kill -9 "$pid" 2>/dev/null
          ORPHANS=$((ORPHANS + 1))
        fi
      done
      for pid in $(pgrep -f "gemini.*--output-format\|gemini.*--yolo" 2>/dev/null); do
        local ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | xargs)
        if ! pgrep -f "bun.*discord-relay" | grep -q "$ppid"; then
          echo "☠️  Killing orphaned Gemini CLI (PID $pid, parent $ppid)"
          kill -9 "$pid" 2>/dev/null
          ORPHANS=$((ORPHANS + 1))
        fi
      done
      [ "$ORPHANS" -eq 0 ] && echo "✅ No orphaned CLI processes"
      echo "Done."
      ;;

    health|h)
      echo "━━━ Discord Relay Health ━━━"
      echo ""
      # Daemon status
      relay status
      echo ""
      # CLIs
      if command -v claude &>/dev/null; then
        echo "🟣 Claude CLI: $(claude --version 2>/dev/null || echo 'installed')"
      else
        echo "❌ Claude CLI: not found"
      fi
      if command -v opencode &>/dev/null; then
        echo "🟢 OpenCode CLI: $(opencode version 2>/dev/null | head -1 || echo 'installed')"
      else
        echo "⚪ OpenCode CLI: not found (optional)"
      fi
      if command -v gemini &>/dev/null; then
        echo "🔵 Gemini CLI: $(gemini --version 2>/dev/null || echo 'installed')"
      else
        echo "⚪ Gemini CLI: not found (optional)"
      fi
      # Bun
      if command -v bun &>/dev/null; then
        echo "✅ Bun: $(bun --version)"
      else
        echo "❌ Bun: not found"
      fi
      echo ""
      # Config
      if [ -f "$RELAY_DIR/.env.local" ]; then
        echo "✅ Config: .env.local present"
        # Check which bot tokens are configured
        grep -q "DISCORD_BOT_TOKEN=" "$RELAY_DIR/.env.local" && echo "   🟣 Claude Code token: set"
        grep -q "DISCORD_BOT_TOKEN_OPENCODE=" "$RELAY_DIR/.env.local" && \
          [ -n "$(grep 'DISCORD_BOT_TOKEN_OPENCODE=' "$RELAY_DIR/.env.local" | cut -d= -f2)" ] && \
          echo "   🟢 OpenCode token: set"
        grep -q "DISCORD_BOT_TOKEN_GEMINI=" "$RELAY_DIR/.env.local" && \
          [ -n "$(grep 'DISCORD_BOT_TOKEN_GEMINI=' "$RELAY_DIR/.env.local" | cut -d= -f2)" ] && \
          echo "   🔵 Gemini token: set"
      else
        echo "❌ Config: .env.local missing"
      fi
      echo ""
      # Lock
      if [ -f "$LOCK_FILE" ]; then
        local LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
        if kill -0 "$LOCK_PID" 2>/dev/null; then
          echo "🔒 Lock: held by PID $LOCK_PID (healthy)"
        else
          echo "⚠️  Lock: STALE (PID $LOCK_PID dead) — run 'relay clean'"
        fi
      else
        echo "🔓 Lock: none"
      fi
      # Daemon installed?
      if [ -f "$HOME/Library/LaunchAgents/$DAEMON_NAME.plist" ]; then
        echo "✅ Daemon: installed (auto-start on login)"
      else
        echo "⚪ Daemon: not installed (run 'relay install')"
      fi
      echo ""
      # Recent activity
      echo "━━━ Last 5 log lines ━━━"
      tail -5 "$LOG_FILE" 2>/dev/null || echo "(no logs)"
      ;;

    help|*)
      echo "relay — Discord Multi-Bot Relay Manager (Claude Code + OpenCode + Gemini CLI)"
      echo ""
      echo "  relay status   (s)   Check if relay is running"
      echo "  relay start          Start the relay daemon"
      echo "  relay stop           Stop the relay daemon"
      echo "  relay restart  (r)   Restart the relay daemon"
      echo "  relay health   (h)   Full health check (CLIs, tokens, lock, daemon)"
      echo "  relay ps       (p)   Show all relay & CLI processes"
      echo "  relay logs [N] (l)   Show last N log lines (default 30)"
      echo "  relay errors   (e)   Show recent errors"
      echo "  relay follow   (f)   Follow logs in real-time"
      echo "  relay fg             Run in foreground (stops daemon)"
      echo "  relay kill     (k)   Force-kill all relay & CLI processes"
      echo "  relay clean    (c)   Remove stale locks & orphaned CLIs"
      echo "  relay install        Install as launchd daemon (auto-start)"
      echo "  relay uninstall      Remove launchd daemon"
      ;;
  esac
}
