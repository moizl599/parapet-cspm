#!/usr/bin/env bash
# install.sh — one-command setup for Parapet (macOS / Linux).
# Checks Docker, creates .env, builds & starts the stack, pulls the LLM model,
# and waits until everything is healthy.

set -euo pipefail

DEFAULT_MODEL="qwen2.5:7b"
APP_URL="http://localhost:3000"

say()  { printf "\n\033[1;34m==>\033[0m %s\n" "$1"; }
ok()   { printf "    \033[0;32m✓\033[0m %s\n" "$1"; }
warn() { printf "    \033[0;33m!\033[0m %s\n" "$1"; }
die()  { printf "\n\033[0;31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

say "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop and retry."
docker info >/dev/null 2>&1 || die "Docker daemon isn't running. Start Docker Desktop and retry."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 not found. Update Docker Desktop."
ok "Docker and Compose are available"

say "Configuring environment"
if [[ ! -f .env ]]; then
  cp .env.example .env
  ok "Created .env from .env.example"
  warn "Add your READ-ONLY AWS credentials to .env before scanning (see docs/AWS_SETUP.md)."
else
  ok ".env already exists — leaving it untouched"
fi

# Determine the model to pull (respect OLLAMA_MODEL in .env, else default).
MODEL="$(grep -E '^OLLAMA_MODEL=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r')"
[[ -z "$MODEL" ]] && MODEL="$DEFAULT_MODEL"

say "Building and starting the stack (this may take a few minutes)"
docker compose up -d --build
ok "Containers started"

say "Waiting for Ollama to be ready"
for i in $(seq 1 30); do
  if docker compose exec -T ollama ollama list >/dev/null 2>&1; then ok "Ollama is up"; break; fi
  [[ $i -eq 30 ]] && die "Ollama did not become ready in time. Check: docker compose logs ollama"
  sleep 2
done

say "Pulling the LLM model: $MODEL (one-time, ~5 GB)"
docker compose exec -T ollama ollama pull "$MODEL"
ok "Model $MODEL ready"

say "Verifying app health"
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/api/health/ollama" 2>/dev/null || echo 000)"
  if [[ "$code" == "200" ]]; then ok "App is healthy"; break; fi
  [[ $i -eq 30 ]] && warn "Health endpoint not 200 yet (got $code). The app may still be starting — check $APP_URL."
  sleep 2
done

printf "\n\033[1;32mParapet is up.\033[0m  Open %s\n" "$APP_URL"
printf "Next: add read-only AWS creds to .env (docs/AWS_SETUP.md), then 'docker compose up -d web' and run a scan.\n\n"
