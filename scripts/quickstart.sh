#!/usr/bin/env bash
# One command from a fresh clone to a running stack on local k3d:
# checks the tools, creates the cluster if missing, builds, installs, prints where to go.
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || missing+=("$1"); }
missing=()
for tool in docker kubectl helm k3d node pnpm jq; do need "$tool"; done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing: ${missing[*]}"
  echo "macOS:  brew install ${missing[*]/docker/--cask docker}"
  echo "Linux:  see docs/deployment.md for each tool's install page"
  exit 1
fi
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start it and run this again."; exit 1; }

pnpm install --frozen-lockfile
k3d cluster list urumi >/dev/null 2>&1 || make cluster
kubectl --context k3d-urumi wait --for=condition=Ready nodes --all --timeout=180s >/dev/null
make up

secret() { kubectl --context k3d-urumi -n "$1" get secret "$2" -o "jsonpath={.data.$3}" | base64 -d; }
cat <<INFO

  Ready.

  Storefront          http://store.127.0.0.1.nip.io
  WooCommerce admin   http://store.127.0.0.1.nip.io/wp-admin   admin / $(secret store wordpress admin-password)
  Dashboard           http://app.127.0.0.1.nip.io              admin@urumi.local / $(secret platform gateway admin-password)
  MCP endpoint        http://app.127.0.0.1.nip.io/mcp          (create a key under API keys)

  Next: make e2e      run the 82 end-to-end checks
        k3d cluster stop urumi    pause everything, data kept
INFO
