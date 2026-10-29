# ---- Safe App build (Vite) ----
FROM oven/bun:1 AS app
WORKDIR /app

COPY package.json .npmrc ./
# bun.lock is gitignored, so don't require a frozen lockfile here.
RUN bun install

COPY . .

# Vite inlines VITE_* at build time, so the values must be present NOW.
# In Coolify set these as Build-time variables / build args — define them at the
# project level so every deployment, including each PR preview, inherits them.
ARG VITE_PINATA_JWT
ENV VITE_PINATA_JWT=$VITE_PINATA_JWT
# URL of the Intuition publisher. Defaults to the same-origin path served by this
# same container (Caddy reverse-proxies /intuition/* -> the in-container publisher),
# so it works on every preview + prod with no per-env config. Override only to
# point at an external publisher service.
ARG VITE_INTUITION_PUBLISHER_URL=/intuition
ENV VITE_INTUITION_PUBLISHER_URL=$VITE_INTUITION_PUBLISHER_URL
ARG VITE_INTUITION_PUBLISHER_SECRET
ENV VITE_INTUITION_PUBLISHER_SECRET=$VITE_INTUITION_PUBLISHER_SECRET
# Build-time fallback for the Safe App's Intuition network. The runtime
# INTUITION_NETWORK env var wins at container start (entrypoint writes it into
# /safe-app/env.js) — so flipping testnet <-> mainnet needs no rebuild. This ARG
# only matters for non-container builds / when no runtime config is injected.
ARG VITE_INTUITION_NETWORK=testnet
ENV VITE_INTUITION_NETWORK=$VITE_INTUITION_NETWORK
RUN bun run build
# -> /app/dist (asset URLs prefixed with /safe-app/)

# ---- Website build (Fumadocs, Next static export) ----
FROM node:22-alpine AS site
WORKDIR /site

COPY website/package.json website/package-lock.json ./
# Skip the fumadocs-mdx postinstall here: the source config isn't copied yet, and
# `next build` regenerates the MDX collections anyway via the createMDX plugin.
RUN npm ci --ignore-scripts

COPY website/ ./
# Next inlines NEXT_PUBLIC_* at build time. Which Intuition network the /redeem
# page queries: testnet on previews, mainnet on prod. Set as a Coolify build var.
ARG NEXT_PUBLIC_INTUITION_NETWORK=testnet
ENV NEXT_PUBLIC_INTUITION_NETWORK=$NEXT_PUBLIC_INTUITION_NETWORK
RUN npm run build
# -> /site/out

# ---- Serve stage ----
# Caddy serves the static apps AND reverse-proxies /intuition/* to the Intuition
# publisher (a bun process) running in this same container. One deploy, one origin,
# no CORS. The publisher holds INTUITION_ATTESTOR_PK + PINATA_JWT as RUNTIME env
# (never VITE_ — those are baked into the public bundle). If the publisher can't
# start (e.g. missing key), Caddy still serves the site; auto-publish just degrades.
FROM caddy:2 AS caddybin

FROM oven/bun:1
# Caddy is a static binary — drop it into the bun image. Give it writable storage
# dirs (it serves :80 only; Coolify terminates TLS, so no certs are managed here).
COPY --from=caddybin /usr/bin/caddy /usr/bin/caddy
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/config
RUN mkdir -p /data /config

# Static apps: website at the root, Safe App SPA under /safe-app.
COPY --from=site /site/out /srv
COPY --from=app /app/dist /srv/safe-app

# Branding playgrounds: plain static pages, no build step. Caddy's root
# file_server picks them up, so branding/x.html is served at /branding/x.
COPY branding /srv/branding

# The publisher app (source + deps) to run with bun.
COPY --from=app /app/node_modules /publisher/node_modules
COPY --from=app /app/package.json /publisher/package.json
COPY --from=app /app/src /publisher/src
COPY --from=app /app/server /publisher/server

COPY Caddyfile /etc/caddy/Caddyfile
COPY server/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV INTUITION_NETWORK=testnet
# The publisher's internal port. NOT `PORT` — platforms (Coolify) inject PORT for
# the main listener (Caddy on :80); reusing it makes the publisher try to bind :80.
ENV INTUITION_PUBLISHER_PORT=8787
EXPOSE 80
CMD ["/entrypoint.sh"]
