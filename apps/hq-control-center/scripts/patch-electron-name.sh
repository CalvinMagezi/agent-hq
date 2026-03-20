#!/bin/bash
# Patches the Electron.app bundle's Info.plist to show the correct app name
# in the macOS Dock and system UI during development.
# This needs to be re-run after `bun install` updates the electron package.

APP_NAME="Agent HQ Control Center"

# Find the electron dist folder (works with bun/npm/yarn workspace hoisting)
ELECTRON_PATH=$(node -e "require('child_process').execSync('node -p \"require.resolve(\\\"electron\\\")\"', {encoding: 'utf8', stdio: ['pipe','pipe','ignore']}).trim()" 2>/dev/null || \
  node -e "try{require.resolve('electron')}catch(e){}" 2>/dev/null)

PLIST="$(cd "$(dirname "$0")/../" && node -e "const p=require('path'); const s=require('fs'); const e=require('electron'); console.log(p.join(p.dirname(e), 'dist', 'Electron.app', 'Contents', 'Info.plist'))" 2>/dev/null)"

# Fallback: look in monorepo root node_modules
if [ -z "$PLIST" ] || [ ! -f "$PLIST" ]; then
  PLIST="$(cd "$(dirname "$0")/../../.." && echo "$(pwd)/node_modules/electron/dist/Electron.app/Contents/Info.plist")"
fi

if [ ! -f "$PLIST" ]; then
  echo "⚠️  Could not find Electron.app Info.plist. Skipping patch."
  exit 0
fi

echo "📄 Patching: $PLIST"
plutil -replace CFBundleName -string "$APP_NAME" "$PLIST"
plutil -replace CFBundleDisplayName -string "$APP_NAME" "$PLIST"
echo "✅ Electron app name patched to: $APP_NAME"
