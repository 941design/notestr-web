#!/usr/bin/env bash
# Generate public/manifest.json with the configured base path.
set -euo pipefail

BASE="${NEXT_PUBLIC_BASE_PATH:-}"

cat > public/manifest.json <<EOF
{
  "name": "notestr — encrypted task manager",
  "short_name": "notestr",
  "description": "Encrypted task manager on Nostr with MLS groups",
  "theme_color": "#0d1117",
  "background_color": "#0d1117",
  "display": "standalone",
  "scope": "${BASE}/",
  "start_url": "${BASE}/",
  "icons": [
    {
      "src": "${BASE}/icon.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any"
    }
  ]
}
EOF
