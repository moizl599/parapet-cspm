# install.ps1 — one-command setup for Parapet (Windows / PowerShell).
# Checks Docker, creates .env (and sets HOST_SCANS_DIR for Windows), builds &
# starts the stack, pulls the LLM model, and waits until everything is healthy.

$ErrorActionPreference = "Stop"
$DefaultModel = "qwen2.5:7b"
$AppUrl = "http://localhost:3000"

function Say($m)  { Write-Host "`n==> $m" -ForegroundColor Blue }
function Ok($m)   { Write-Host "    [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    [!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "`n[x] $m" -ForegroundColor Red; exit 1 }

Say "Checking prerequisites"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die "Docker is not installed. Install Docker Desktop and retry." }
try { docker info *> $null } catch { Die "Docker daemon isn't running. Start Docker Desktop and retry." }
docker compose version *> $null; if ($LASTEXITCODE -ne 0) { Die "Docker Compose v2 not found. Update Docker Desktop." }
Ok "Docker and Compose are available"

Say "Configuring environment"
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Ok "Created .env from .env.example"
  Warn "Add your READ-ONLY AWS credentials to .env before scanning (see docs/AWS_SETUP.md)."
} else {
  Ok ".env already exists — leaving it untouched"
}

# On Windows, set HOST_SCANS_DIR to this repo's scans path if it's blank.
$scansPath = (Join-Path (Get-Location) "scans")
$envLines = Get-Content ".env"
if ($envLines -match '^HOST_SCANS_DIR=\s*$') {
  $envLines = $envLines -replace '^HOST_SCANS_DIR=\s*$', "HOST_SCANS_DIR=$scansPath"
  Set-Content ".env" $envLines
  Ok "Set HOST_SCANS_DIR=$scansPath"
}

# Determine the model to pull (respect OLLAMA_MODEL in .env, else default).
$modelLine = (Get-Content ".env" | Select-String '^OLLAMA_MODEL=' | Select-Object -Last 1)
$Model = if ($modelLine) { ($modelLine -replace '^OLLAMA_MODEL=', '').Trim() } else { $DefaultModel }
if ([string]::IsNullOrWhiteSpace($Model)) { $Model = $DefaultModel }

Say "Building and starting the stack (this may take a few minutes)"
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Die "docker compose up failed." }
Ok "Containers started"

Say "Waiting for Ollama to be ready"
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  docker compose exec -T ollama ollama list *> $null
  if ($LASTEXITCODE -eq 0) { Ok "Ollama is up"; $ready = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ready) { Die "Ollama did not become ready. Check: docker compose logs ollama" }

Say "Pulling the LLM model: $Model (one-time, ~5 GB)"
docker compose exec -T ollama ollama pull $Model
Ok "Model $Model ready"

Say "Verifying app health"
for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "$AppUrl/api/health/ollama" -TimeoutSec 5
    if ($r.StatusCode -eq 200) { Ok "App is healthy"; break }
  } catch { }
  if ($i -eq 29) { Warn "Health endpoint not ready yet. The app may still be starting — check $AppUrl." }
  Start-Sleep -Seconds 2
}

Write-Host "`nParapet is up.  Open $AppUrl" -ForegroundColor Green
Write-Host "Next: add read-only AWS creds to .env (docs/AWS_SETUP.md), then 'docker compose up -d web' and run a scan.`n"
