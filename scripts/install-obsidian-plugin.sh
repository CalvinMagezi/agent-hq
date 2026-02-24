#!/bin/bash
# Install the Agent-HQ Vault Sync plugin into the local Obsidian vault.
#
# Usage: bash scripts/install-obsidian-plugin.sh
#
# This copies the built plugin artifacts (main.js, manifest.json, styles.css)
# to .vault/.obsidian/plugins/agent-hq-vault-sync/

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_SRC="$REPO_ROOT/plugins/obsidian-vault-sync"
VAULT_PLUGIN_DIR="$REPO_ROOT/.vault/.obsidian/plugins/agent-hq-vault-sync"

# Check that the plugin has been built
if [ ! -f "$PLUGIN_SRC/main.js" ]; then
  echo "Plugin not built yet. Building..."
  cd "$PLUGIN_SRC" && bun run build
fi

# Create the plugin directory in the vault
mkdir -p "$VAULT_PLUGIN_DIR"

# Copy artifacts
cp "$PLUGIN_SRC/main.js" "$VAULT_PLUGIN_DIR/"
cp "$PLUGIN_SRC/manifest.json" "$VAULT_PLUGIN_DIR/"
cp "$PLUGIN_SRC/styles.css" "$VAULT_PLUGIN_DIR/"

echo "Plugin installed to: $VAULT_PLUGIN_DIR"
echo ""
echo "To activate:"
echo "  1. Open Obsidian"
echo "  2. Go to Settings > Community Plugins"
echo "  3. Enable 'Agent-HQ Vault Sync'"
echo "  4. Configure server URL and encryption passphrase in plugin settings"
