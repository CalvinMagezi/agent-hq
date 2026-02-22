#!/usr/bin/env bash
# setup-gemini-plugins.sh
# One-time setup for Gemini CLI plugins: auth, extensions, and global MCP server config.
#
# Usage: bash scripts/setup-gemini-plugins.sh
#
# What this does:
#   1. Authenticates your Google account (gemini login)
#   2. Installs the Google Workspace extension (Keep, Drive, Calendar, Gmail, Docs, Sheets)
#   3. Writes ~/.gemini/settings.json with recommended global MCP servers
#
# After running, plugins are available globally to Gemini CLI.
# The relay also manages project-level plugins via:
#   - !plugin add / !plugin remove (Discord commands)
#   - .discord-relay-gemini/gemini-plugins.json (persisted config)
#   - .gemini/settings.json (synced from relay config on startup)

set -e

echo "=== Gemini CLI Plugin Setup ==="
echo ""

# ── Check gemini CLI is installed ───────────────────────────────────────────
if ! command -v gemini &>/dev/null; then
  echo "ERROR: 'gemini' CLI not found. Install it first:"
  echo "  npm install -g @google/gemini-cli"
  exit 1
fi

GEMINI_VERSION=$(gemini --version 2>/dev/null || echo "unknown")
echo "Gemini CLI found: $GEMINI_VERSION"
echo ""

# ── Step 1: Authenticate ─────────────────────────────────────────────────────
echo "Step 1/3: Google Account Authentication"
echo "This opens a browser OAuth flow to link your Google account."
echo "Tokens will be stored in ~/.gemini/ and persist across sessions."
echo ""
read -p "Run 'gemini login' now? [Y/n] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
  gemini login
  echo "Authentication complete."
else
  echo "Skipped. Run 'gemini login' manually to authenticate."
fi

echo ""

# ── Step 2: Install Google Workspace Extension ───────────────────────────────
echo "Step 2/3: Google Workspace Extension"
echo "Provides access to: Keep, Drive, Calendar, Gmail, Docs, Sheets, Chat"
echo "Extension URL: https://github.com/gemini-cli-extensions/workspace"
echo ""
read -p "Install Google Workspace extension? [Y/n] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
  gemini extensions install https://github.com/gemini-cli-extensions/workspace || {
    echo "NOTE: Extension install may need manual auth prompts — follow any browser prompts."
  }
  echo "Workspace extension installed."
else
  echo "Skipped. Install manually with:"
  echo "  gemini extensions install https://github.com/gemini-cli-extensions/workspace"
fi

echo ""

# ── Step 3: Global MCP Server Config ─────────────────────────────────────────
echo "Step 3/3: Global MCP Server Configuration (~/.gemini/settings.json)"
echo "This adds MCP servers available to Gemini CLI in all projects."
echo ""

GEMINI_CONFIG_DIR="$HOME/.gemini"
SETTINGS_FILE="$GEMINI_CONFIG_DIR/settings.json"

mkdir -p "$GEMINI_CONFIG_DIR"

# Detect vault path (default to project vault)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DEFAULT_VAULT_PATH="$REPO_ROOT/.vault"

read -p "Vault path [$DEFAULT_VAULT_PATH]: " VAULT_PATH
VAULT_PATH="${VAULT_PATH:-$DEFAULT_VAULT_PATH}"

read -p "Write global MCP server config to $SETTINGS_FILE? [Y/n] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
  # Read existing settings if present
  if [[ -f "$SETTINGS_FILE" ]]; then
    echo "Existing $SETTINGS_FILE found — merging mcpServers section."
    EXISTING_SETTINGS=$(cat "$SETTINGS_FILE")
  else
    EXISTING_SETTINGS="{}"
  fi

  # Write settings with mcpServers (using jq if available, else overwrite)
  if command -v jq &>/dev/null; then
    echo "$EXISTING_SETTINGS" | jq --arg vault "$VAULT_PATH" '
      .mcpServers.obsidian = {
        "command": "npx",
        "args": ["-y", "@mauricio.wolff/mcp-obsidian", $vault],
        "description": "Obsidian vault access (notes, jobs, delegation)",
        "trust": true
      }
    ' > "$SETTINGS_FILE"
  else
    # Fallback: write a simple settings file (overwrites existing mcpServers)
    cat > "$SETTINGS_FILE" <<EOF
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "@mauricio.wolff/mcp-obsidian", "$VAULT_PATH"],
      "description": "Obsidian vault access (notes, jobs, delegation)",
      "trust": true
    }
  }
}
EOF
  fi

  echo "Written: $SETTINGS_FILE"
  echo ""
  echo "Contents:"
  cat "$SETTINGS_FILE"
else
  echo "Skipped. Manually configure $SETTINGS_FILE to add MCP servers."
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "You can also manage project-level plugins via Discord commands:"
echo "  !plugins                           — list plugins"
echo "  !plugin add <name> <cmd> [args...] — add stdio MCP server"
echo "  !plugin add <name> --http <url>    — add HTTP MCP server"
echo "  !plugin remove <name>              — remove plugin"
echo ""
echo "Plugin config is persisted in: .discord-relay-gemini/gemini-plugins.json"
echo "And synced to: .gemini/settings.json (project-level, loaded by Gemini CLI)"
