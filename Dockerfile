# syntax=docker/dockerfile:1
#
# Multi-stage build for the CSPM Analyzer Next.js app.
#   deps    -> install node_modules from the lockfile
#   builder -> next build (emits .next/standalone via output: "standalone")
#   runner  -> slim runtime: standalone server + docker CLI to launch Prowler
#
# The runtime image is intentionally minimal — it does NOT contain node_modules,
# only the traced standalone bundle.

# ---------- deps ----------
FROM node:24-alpine AS deps
WORKDIR /app
# libc6-compat helps native deps run under Alpine's musl libc; python3/make/g++
# (build-base) compile better-sqlite3 from source against this Node/musl ABI.
RUN apk add --no-cache libc6-compat python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

# ---------- builder ----------
FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runner ----------
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The standalone server binds localhost by default; force all interfaces so the
# published port is reachable from the host.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# `docker-cli` lets this container launch Prowler on the HOST daemon through the
# mounted socket; `bash` runs prowler/run-scan.sh.
#
# SECURITY TRADEOFF — mounting /var/run/docker.sock gives this web process FULL
# control of the host Docker daemon (it can start privileged containers, mount
# host paths, etc.). That is effectively host-level access. This is acceptable
# for a LOCAL, SINGLE-USER tool (the whole point is to spawn read-only Prowler
# scans on demand) but it is NOT safe for a shared, multi-tenant, or internet-
# exposed deployment. Do not ship this topology to such environments.
RUN apk add --no-cache docker-cli bash

# Standalone server + the static assets it does not copy automatically.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# The Prowler wrapper is invoked at runtime by src/lib/prowler.ts; it is not
# part of the Next.js trace, so copy it explicitly.
COPY --from=builder /app/prowler ./prowler

# Drizzle migrations are read at startup by instrumentation.ts (not traced).
COPY --from=builder /app/drizzle ./drizzle

# Scan artifacts + SQLite DB dirs; docker-compose bind-mounts host dirs over them.
RUN mkdir -p /app/scans /app/data

EXPOSE 3000

# Note: runs as root so the mounted docker socket is accessible without matching
# the host's docker group GID (which varies, especially on Docker Desktop).
# Reasonable for a local single-user tool; see the security note above.
CMD ["node", "server.js"]
