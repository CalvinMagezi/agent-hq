#!/bin/bash
# Discord Relay Daemon Manager
# Usage: ./daemon.sh [install|uninstall|start|stop|restart|status|logs]

PLIST_NAME="com.agent-hq.discord-relay"
PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/${PLIST_NAME}.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_FILE="$HOME/Library/Logs/discord-relay.log"
ERR_FILE="$HOME/Library/Logs/discord-relay.error.log"

case "${1:-status}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents"
    cp "$PLIST_SRC" "$PLIST_DST"
    launchctl load "$PLIST_DST"
    echo "Installed and started. Relay will auto-start on login."
    echo "Logs: $LOG_FILE"
    ;;

  uninstall)
    launchctl unload "$PLIST_DST" 2>/dev/null
    rm -f "$PLIST_DST"
    echo "Uninstalled. Relay will no longer auto-start."
    ;;

  start)
    launchctl load "$PLIST_DST" 2>/dev/null || launchctl start "$PLIST_NAME"
    echo "Started."
    ;;

  stop)
    launchctl stop "$PLIST_NAME"
    echo "Stopped."
    ;;

  restart)
    launchctl stop "$PLIST_NAME"
    sleep 2
    launchctl start "$PLIST_NAME"
    echo "Restarted."
    ;;

  status)
    if launchctl list | grep -q "$PLIST_NAME"; then
      PID=$(launchctl list | grep "$PLIST_NAME" | awk '{print $1}')
      if [ "$PID" = "-" ]; then
        echo "Registered but not running."
      else
        echo "Running (PID: $PID)"
      fi
    else
      echo "Not installed. Run: ./daemon.sh install"
    fi
    ;;

  logs)
    echo "=== stdout ==="
    tail -50 "$LOG_FILE" 2>/dev/null || echo "(no log file yet)"
    echo ""
    echo "=== stderr ==="
    tail -20 "$ERR_FILE" 2>/dev/null || echo "(no error log yet)"
    ;;

  *)
    echo "Usage: $0 {install|uninstall|start|stop|restart|status|logs}"
    exit 1
    ;;
esac
