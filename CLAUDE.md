# CSPM Analyzer — Project Context

## What we're building
An agentic cloud security posture analyzer. Prowler scans an AWS account and produces a raw misconfiguration report. A local LLM (via Ollama) acts as a senior cloud security engineer: it reads the findings, explains each one in plain language, prioritizes them by real-world risk, and produces a streamlined remediation report. A Next.js dashboard presents all of this.

## Scope (v1)
- AWS only.
- Read-only scanning. The app must NEVER modify cloud resources.
- Local-first: the LLM runs locally via Ollama. No findings data leaves the machine.

## Stack
- Next.js (App Router, TypeScript) for both the UI and the API routes.
- Prowler (`prowlercloud/prowler` Docker image) for scanning, output format `json-ocsf`.
- Ollama (`ollama/ollama`) for the local LLM, OpenAI-compatible API at `http://ollama:11434/v1` inside Docker (`http://localhost:11434/v1` from the host).
- Docker Compose to run everything in Docker Desktop.
- UI built using the `ui-ux-pro-max` skill: modern, dark, dashboard-grade, accessible.

## AWS credentials
- Read-only IAM access keys provided via `.env` (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` / `AWS_DEFAULT_REGION`).
- Document a least-privilege policy (Prowler recommends the AWS managed `SecurityAudit` + `ViewOnlyAccess` policies). Plan to support assume-role later.

## Conventions
- TypeScript strict mode. No `any` in shared lib code.
- Server-side only for anything touching AWS creds or spawning containers. Never expose creds to the client.
- Treat all Prowler output as untrusted input; validate/normalize before use.
- Keep secrets in `.env` (gitignored). Provide `.env.example`.
- Prefer streaming responses for LLM analysis so the UI feels responsive.

## Non-goals (v1)
- Multi-cloud (Azure/GCP/K8s) — later.
- Auto-remediation — we only advise, we never change resources.
- Hosted multi-tenant SaaS — this is a local tool for now.

## Framework notes — this is NOT the Next.js you may know
We're on **Next.js 16** (App Router). It has breaking changes vs. older versions — APIs, conventions, and file structure may differ from training data. **Before writing any framework code, read the relevant guide under `node_modules/next/dist/docs/`** and heed deprecation notices. Known gotchas already confirmed for this version:
- **Route Handler `params` is a `Promise`.** Signature: `export async function GET(request: Request, { params }: { params: Promise<{ id: string }> })`, then `const { id } = await params`. Alternatively use the globally-available `RouteContext<'/api/scan/[id]'>` helper (generated during `next dev`/`build`/`typegen`, no import needed).
- **Dynamic APIs are async** — `cookies()`, `headers()` from `next/headers` must be `await`ed.
- `GET` handlers default to **dynamic** (not statically cached).
- For routes using `child_process`/`fs` (e.g. spawning Prowler), set `export const runtime = 'nodejs'`.

## Running the stack (Docker Desktop)
Everything runs via `docker-compose.yml`:
- **web** — the Next.js app, built from the multi-stage `Dockerfile` (`output: "standalone"` → `node server.js`). Publishes `3000:3000`.
- **ollama** — `ollama/ollama:latest`, publishes `11434:11434`, models persisted in the `ollama_models` named volume.

Workflow:
```bash
docker compose up -d
docker compose exec ollama ollama pull llama3.1:8b   # one-time; persisted in the volume
# open http://localhost:3000
```
The model pull is one-time. The app **degrades gracefully** when Ollama is unreachable or the model isn't pulled — `healthCheck()` (src/lib/ollama.ts) distinguishes the two. Surface it via `GET /api/health/ollama` (works against the running container; 200 ready / 503 otherwise) or, for local non-Docker dev, `npm run check:ollama` (a dev-only script, absent from the slim runtime image).

### How Prowler runs (and the scans-path gotcha)
The web container has no Prowler inside it — it launches Prowler on the **host** Docker daemon via the mounted `/var/run/docker.sock`, installing only the docker CLI in the runtime image. **Security tradeoff:** socket access = full control of the host daemon; acceptable for this local single-user tool, never for shared/hosted use.

Because Prowler runs on the host daemon, Prowler's `-v` mount **source must be a HOST path**, not the web container's `/app/scans`. So `prowler.ts` builds the bind source from `HOST_SCANS_DIR` (the host path bound to `/app/scans` in compose) while reading results back at the container path. When `HOST_SCANS_DIR` is unset (running directly on the host) the two paths coincide. On Windows/Docker Desktop, set `HOST_SCANS_DIR` to an absolute host path in `.env`.

## Framework notes — Docker / standalone
- `next.config.ts` sets `output: "standalone"`; the build emits `.next/standalone/server.js`. The Dockerfile copies the standalone bundle plus `public/` and `.next/static/` (standalone does not copy those automatically), and `prowler/` (not part of the Next trace). Start with `node server.js`; set `HOSTNAME=0.0.0.0` and `PORT` so the published port is reachable.

## Agent context
`CLAUDE.md` (this file) is the single source of truth for project context. `AGENTS.md` only points here — do not duplicate guidance across both.
