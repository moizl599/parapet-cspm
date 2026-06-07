# syntax=docker/dockerfile:1
#
# Multi-stage build for the Parapet Next.js app (local / Docker Desktop).
#   deps    -> install node_modules from the lockfile
#   builder -> next build (emits .next/standalone via output: "standalone")
#   runner  -> slim runtime: standalone server + docker CLI (to launch Prowler on
#              the host daemon) + PMapper/aws-cli (optional AP-5 IAM graph scanner)
#
# All stages use node:24-slim (Debian/glibc) so native modules (better-sqlite3)
# share one ABI across build and runtime — do NOT mix with Alpine/musl stages.

# ---------- deps ----------
FROM node:24-slim AS deps
WORKDIR /app
# Build tools in case better-sqlite3 has no prebuilt binary for this Node ABI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---------- builder ----------
FROM node:24-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runner ----------
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The standalone server binds localhost by default; force all interfaces so the
# published port is reachable from the host.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# PMapper CLI from the pip install below lives on the system PATH.
ENV DOCKER_CLI_VERSION=27.3.1

# Runtime tools:
#  - docker (static client only) launches Prowler on the HOST daemon through the
#    mounted socket; `bash` runs prowler/run-scan.sh and prowler/run-pmapper.sh.
#  - python3 + principalmapper (PMapper) + aws-cli v2 power the optional AP-5 IAM
#    graph scanner (run-pmapper.sh); only used when PMAPPER_ENABLED=true.
#
# SECURITY TRADEOFF — mounting /var/run/docker.sock gives this web process FULL
# control of the host Docker daemon (start privileged containers, mount host
# paths, etc.) — effectively host-level access. Acceptable for a LOCAL,
# SINGLE-USER tool; NOT for a shared/multi-tenant/internet-exposed deployment.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl unzip python3 python3-pip \
 && pip3 install --no-cache-dir --break-system-packages principalmapper \
 # PMapper 1.1.5 predates Python 3.10: it does `from collections import Mapping`
 # which moved to collections.abc. One file; patch it so PMapper runs on the
 # slim image's Python 3.11. (Remove if a newer PMapper release fixes this.)
 && find /usr/local/lib -path '*/principalmapper/util/case_insensitive_dict.py' -exec \
      sed -i 's/from collections import Mapping, MutableMapping, OrderedDict/from collections import OrderedDict\nfrom collections.abc import Mapping, MutableMapping/' {} + \
 && curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-${DOCKER_CLI_VERSION}.tgz" \
      | tar -xz --strip-components=1 -C /usr/local/bin docker/docker \
 && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip \
 && unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install \
 && rm -rf /tmp/aws /tmp/awscliv2.zip /var/lib/apt/lists/*

# Standalone server + the static assets it does not copy automatically.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# The Prowler / PMapper wrappers are invoked at runtime (not part of the Next.js
# trace), so copy them explicitly.
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
