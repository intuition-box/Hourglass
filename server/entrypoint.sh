#!/bin/sh
# Run the Intuition publisher (bun) in the background and Caddy in the foreground.
# If the publisher exits (e.g. INTUITION_ATTESTOR_PK unset), Caddy keeps serving
# the static apps — auto-publish degrades, the site stays up.
set -e

# Inject the runtime Intuition network into the static Safe App. Vite would
# otherwise bake VITE_INTUITION_NETWORK at build time; writing env.js here lets a
# plain INTUITION_NETWORK env change flip testnet <-> mainnet without a rebuild.
printf 'window.__OG__={network:"%s"}\n' "${INTUITION_NETWORK:-testnet}" > /srv/safe-app/env.js

( cd /publisher && bun server/intuition-publisher.ts; echo "[entrypoint] publisher exited ($?)" ) &

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
