#!/bin/sh
# Package Crabyard for this Mac and install it to /Applications.
# Local build only: no notarization, ad-hoc signed so Apple Silicon runs it.
# Run via `npm run app` (which builds first).
set -eu
cd "$(dirname "$0")/.."

npx electron-builder --mac --dir \
  -c.directories.output=out \
  -c.electronDist=node_modules/electron/dist \
  -c.npmRebuild=false \
  -c.mac.notarize=false \
  -c.mac.identity=null

APP=$(ls -d out/mac*/Crabyard.app | head -n 1)
codesign --force --deep --sign - "$APP"

rm -rf /Applications/Crabyard.app
ditto "$APP" /Applications/Crabyard.app
echo "Installed /Applications/Crabyard.app"
