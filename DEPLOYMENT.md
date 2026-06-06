# Deployment Guide

Parapet runs as a small local stack on **Docker Desktop**: a `web` service (the Next.js app) and an `ollama` service (the local LLM). Prowler is launched on demand on the host Docker daemon. This guide covers prerequisites, configuration, bringing the stack up, and troubleshooting.

> For AWS credential setup (read-only IAM user or assume-role), see the **[AWS Setup Guide](docs/AWS_SETUP.md)**.

---

## 1. Prerequisites

- **Docker Desktop** running (provides Docker Engine + Compose v2).
- **Read-only AWS credentials** — an IAM user with the AWS-managed `SecurityAudit` + `ViewOnlyAccess` policies, or a read-only role for assume-role mode. See [AWS Setup](docs/AWS_SETUP.md).
- **~6 GB free disk** — for the LLM model (~4.7 GB) and the Prowler image.
- **Ports 3000 and 11434 free** on the host.

---

## 2. Get the code

```bash
git clone https://github.com/moizl599/parapet-cspm.git
cd parapet-cspm
```

---

## 3. Configure environment

Copy the template and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AWS_ACCESS_KEY_ID` | for scanning | — | Read-only IAM key. Only validated when a scan runs. |
| `AWS_SECRET_ACCESS_KEY` | for scanning | — | Read-only IAM secret. |
| `AWS_REGION` | recommended | `us-east-1` | Takes precedence over `AWS_DEFAULT_REGION`. |
| `AWS_DEFAULT_REGION` | recommended | `us-east-1` | Fallback region. |
| `OLLAMA_BASE_URL` | no | `http://localhost:11434/v1` | Compose overrides this to `http://ollama:11434/v1` for the `web` service — leave as-is. |
| `OLLAMA_MODEL` | no | `qwen2.5:7b` | Compose default. Change it (and pull that tag) to use another model. |
| `HOST_SCANS_DIR` | **Windows: yes** | `${PWD}/scans` | See the note below — must be a **host** path. |
| `DATA_DIR` | no | `/app/data` (compose) | SQLite directory; backed by the `./data` volume. |

> The stack boots **without** AWS credentials — they're only validated when you actually run a scan. So you can bring everything up first and add keys later.

### Windows / Docker Desktop — `HOST_SCANS_DIR`

The `web` container launches Prowler on the **host** Docker daemon, so Prowler's bind-mount source must be a path the **host** understands (not the container's `/app/scans`). On Windows, set it explicitly in `.env`:

```
HOST_SCANS_DIR=C:\Users\you\Desktop\parapet-cspm\scans
```

On Linux/macOS the compose default `${PWD}/scans` usually works and you can leave it unset. This only matters once you run a real scan — a misconfigured path shows up as "expected OCSF output not found."

---

## 4. Bring up the stack

### Option A — installer (recommended)

```bash
./install.sh          # macOS / Linux
./install.ps1         # Windows PowerShell
```

The installer verifies Docker, creates `.env` if missing, builds and starts the stack, pulls the model, and polls until healthy.

### Option B — manual

```bash
docker compose up -d --build
docker compose exec ollama ollama pull qwen2.5:7b   # one-time, persisted in a volume
```

Then open **http://localhost:3000**.

---

## 5. Verify it's healthy

```bash
# App + Ollama readiness (200 ready / 503 otherwise)
curl http://localhost:3000/api/health/ollama

# Both containers up
docker compose ps

# Model present
docker compose exec ollama ollama list
```

`/api/health/ollama` returns a structured status: `ready`, `unreachable`, or `model-not-found`. The app **never crashes** when Ollama isn't ready — it surfaces the state in the UI so you can fix it.

---

## 6. Important: rebuilding after code changes

When you change code and want it live in the container, rebuild **and** recreate atomically:

```bash
docker compose up -d --build --force-recreate web
```

A plain `docker compose build` followed by a separate `up` can leave the container running a **stale image** on some Docker Desktop setups (containerd image store). If a container's behaviour contradicts the code you just built, suspect a stale image before suspecting the code.

---

## 7. Data & persistence

- **SQLite database** lives in `./data/cspm.db` (the `./data` volume). It survives container rebuilds and restarts — your scan history and environments persist.
- **Scan artifacts** (raw JSON-OCSF) live in `./scans/`.
- **LLM models** persist in the `ollama_models` named volume — you pull each model only once.

To reset everything (⚠️ deletes history): `docker compose down` then remove `./data` and `./scans`.

---

## 8. Updating

```bash
git pull
docker compose up -d --build --force-recreate
```

Database migrations run automatically on startup (idempotent).

---

## 9. Development without Docker

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # unit tests (Node's built-in runner)
npm run typecheck
npm run lint
npm run check:ollama # requires a local `ollama serve` on :11434
```

For local dev, point `OLLAMA_BASE_URL` at `http://localhost:11434/v1` and run Ollama on the host (or keep the compose `ollama` service up and reach it on the published port).

---

## Troubleshooting

**`/api/health/ollama` says `unreachable`**
Ollama isn't running or isn't reachable. Check `docker compose ps` and `docker compose logs ollama`. The `web` service reaches Ollama at `http://ollama:11434/v1` (compose network), not `localhost`.

**`model-not-found`**
Ollama is up but the model isn't pulled:
```bash
docker compose exec ollama ollama pull qwen2.5:7b
docker compose exec ollama ollama list
```

**Scans fail / "docker not found" / socket permission errors**
- Confirm the socket mount is present in `docker-compose.yml` (`/var/run/docker.sock:/var/run/docker.sock`).
- On Docker Desktop, enable file/socket sharing for your drive.
- Ensure the host can pull Prowler: `docker pull prowlercloud/prowler`.

**"expected OCSF output not found"**
`HOST_SCANS_DIR` doesn't point at the same host directory bound to `/app/scans`. Re-check the Windows note in §3.

**Analysis is slow**
LLM inference on CPU is slow (minutes per chunk; a large account can take ~an hour). The analysis runs in the background — it's safe to close the tab. For fast analysis, run Ollama on a GPU. The pipeline still produces a **partial report** if a chunk fails, so you always get usable output.

**Port already in use (3000 / 11434)**
Stop the conflicting process or remap the port in `docker-compose.yml`.

**Container shows old behaviour after a code change**
Stale image — see §6, use `docker compose up -d --build --force-recreate web`.
