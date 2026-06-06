# Deploying Parapet on Azure Kubernetes Service (AKS)

Parapet was built as a **local, single-user** tool (Docker Desktop). Running it on a shared cluster like AKS is possible, but it is **not** a drop-in `kubectl apply` — the design makes a few assumptions that must change first. This guide explains those changes honestly, then walks through a working CPU-based deployment with the manifests in [`deploy/aks/`](../deploy/aks).

> **Read this section before anything else.** Skipping the architecture changes will either fail or be insecure.

---

## What has to change for a cluster (and why)

| Local assumption | Why it breaks on AKS | What we do instead |
|---|---|---|
| Launches Prowler via the **host Docker socket** | AKS nodes run containerd, not Docker; mounting a node's runtime socket ≈ node compromise (the exact "not for shared/hosted" case in [SECURITY.md](../SECURITY.md)) | **Bake Prowler into the image** and run it as a subprocess (`Dockerfile.aks`, `PROWLER_EXEC_MODE=local`) |
| **No authentication** (single-user) | On an Ingress, anyone reaching the URL can scan and read findings | Put auth in front — basic auth minimum, oauth2-proxy/Entra ID for real use |
| **SQLite on a local volume** | A `ReadWriteOnce` Azure Disk binds to one node, so you can't scale past 1 replica | Single replica for v1; migrate to Postgres to scale (see end) |
| **Ollama on your laptop** | Needs real CPU/RAM in-cluster; CPU inference is slow | Dedicated Ollama Deployment + model PVC; size the node pool for it |
| **"Nothing leaves your machine"** | Findings now live in your Azure cluster | Still private to *your* cluster, but it's a different trust boundary — worth stating to stakeholders |

### The `PROWLER_EXEC_MODE` switch (implemented)

The baked-in Prowler image only helps if the app calls the `prowler` CLI instead of `docker run`. This is handled by `prowler/run-scan.sh` via the `PROWLER_EXEC_MODE` environment variable:

- `socket` (**default**) → unchanged local behaviour: `docker run prowlercloud/prowler aws ...` via the mounted Docker socket.
- `local` → runs the installed `prowler aws ...` CLI directly as a subprocess (no Docker, no `-v` mounts), writing OCSF output straight into the pod-local scans dir. `HOST_SCANS_DIR` is irrelevant in this mode.

`Dockerfile.aks` sets `PROWLER_EXEC_MODE=local`, so the cluster image uses the in-process path automatically. Assume-role (`--role`/`--external-id`) and region filters work identically in both modes. Nothing else in the app changes — the API and the OCSF normalizer are untouched.

> Verify before deploying (run in the repo): `npm run typecheck && npm run lint && npm test && docker compose build`, and confirm a normal local scan (`PROWLER_EXEC_MODE` unset → `socket`) still works.

---

## Prerequisites

- **Azure CLI** (`az`) and **kubectl** installed and logged in (`az login`).
- An Azure subscription with permission to create AKS, ACR, and public IPs.
- **Read-only AWS credentials** (IAM user keys, or a role for assume-role) — see [AWS Setup](AWS_SETUP.md). These are stored as a Kubernetes Secret.
- A DNS name you can point at the cluster (for the Ingress/TLS).

---

## Step 1 — Create the cluster and registry

```bash
az group create -n parapet-rg -l eastus

# Container registry for the image
az acr create -n <yourRegistry> -g parapet-rg --sku Basic

# AKS cluster. A 7B model on CPU needs RAM — Standard_D4s_v5 = 4 vCPU / 16 GB.
az aks create -n parapet-aks -g parapet-rg \
  --node-count 2 --node-vm-size Standard_D4s_v5 \
  --attach-acr <yourRegistry> --generate-ssh-keys

az aks get-credentials -n parapet-aks -g parapet-rg
```

> **Sizing:** Ollama requests 8 Gi RAM for `qwen2.5:7b`. Make sure at least one node can satisfy that alongside system pods. Bump the VM size or node count if pods stay `Pending`.

---

## Step 2 — Build and push the image

```bash
# From the repo root — builds Dockerfile.aks in ACR (no local Docker needed)
az acr build -r <yourRegistry> -t parapet:latest -f Dockerfile.aks .
```

Then edit `deploy/aks/web.yaml` and replace `REPLACE_WITH_ACR_LOGIN_SERVER` with your registry login server (e.g. `<yourRegistry>.azurecr.io`).

---

## Step 3 — Namespace and secrets

```bash
kubectl apply -f deploy/aks/namespace.yaml

# Create the AWS secret imperatively (don't commit real keys):
kubectl -n parapet create secret generic parapet-aws \
  --from-literal=AWS_ACCESS_KEY_ID=AKIA... \
  --from-literal=AWS_SECRET_ACCESS_KEY=... \
  --from-literal=AWS_REGION=us-east-1 \
  --from-literal=AWS_DEFAULT_REGION=us-east-1
```

For production, prefer **Azure Key Vault** with the [Secrets Store CSI driver](https://learn.microsoft.com/azure/aks/csi-secrets-store-driver) instead of a plain Secret.

---

## Step 4 — Deploy Ollama and pull the model

```bash
kubectl apply -f deploy/aks/ollama.yaml
kubectl -n parapet rollout status deploy/ollama

# Pull the model into the volume (one-time)
kubectl apply -f deploy/aks/ollama-model-pull.job.yaml
kubectl -n parapet wait --for=condition=complete job/ollama-model-pull --timeout=1800s
```

The model (~4.7 GB) persists in the `ollama-models` PVC, so you pull it only once.

---

## Step 5 — Deploy the web app

```bash
kubectl apply -f deploy/aks/web.yaml
kubectl -n parapet rollout status deploy/parapet-web
```

Quick smoke test without an Ingress yet:

```bash
kubectl -n parapet port-forward deploy/parapet-web 3000:3000
# then open http://localhost:3000  (and /api/health/ollama should be ready)
```

---

## Step 6 — Expose it (with authentication)

Parapet has **no login of its own**, so never expose it raw. Install the ingress-nginx controller, then:

```bash
# Minimum: HTTP basic auth
htpasswd -c auth parapet                 # set a password
kubectl -n parapet create secret generic parapet-basic-auth --from-file=auth

# Edit deploy/aks/ingress.yaml: set your hostname (parapet.example.com)
kubectl apply -f deploy/aks/ingress.yaml
```

Point your DNS at the ingress controller's external IP, and (if cert-manager is installed) the `cluster-issuer` annotation provisions TLS.

> **For real use, basic auth isn't enough.** Front Parapet with **oauth2-proxy** tied to **Entra ID (Azure AD)** so only your team can reach it. The Ingress then routes through the proxy. This is the single most important hardening step for a hosted Parapet.

---

## Operations

```bash
kubectl -n parapet get pods                       # health
kubectl -n parapet logs deploy/parapet-web         # app logs
kubectl -n parapet logs deploy/ollama              # LLM logs

# Update to a new image build
az acr build -r <yourRegistry> -t parapet:latest -f Dockerfile.aks .
kubectl -n parapet rollout restart deploy/parapet-web
```

Database migrations run automatically on pod start (idempotent), so a rolling restart picks up schema changes.

---

## Caveats & cost

- **Single replica.** SQLite on a `ReadWriteOnce` disk means one `parapet-web` pod. Don't raise `replicas`.
- **CPU inference is slow.** Same minutes-to-an-hour as locally, now on cluster nodes you pay for. A scan+analysis pins a CPU for a while. For speed, add a GPU node pool (`az aks nodepool add ... --node-vm-size Standard_NC4as_T4_v3`), add a `nvidia.com/gpu` resource request to the Ollama Deployment, and install the NVIDIA device plugin — at materially higher cost.
- **Cost control.** Stop paying when idle by scaling the cluster to zero user nodes or deallocating, since Parapet is typically run on-demand, not 24/7.
- **AWS reach.** The cluster needs outbound internet to call AWS APIs through Prowler (default on AKS).

---

## Scaling beyond one replica (optional)

To run multiple `parapet-web` replicas (HA), move off SQLite:

1. Provision **Azure Database for PostgreSQL**.
2. Swap the Drizzle driver from better-sqlite3 to `drizzle-orm/node-postgres`, set a `DATABASE_URL` secret, and drop the `parapet-data` PVC.
3. Raise `replicas` and switch the Deployment strategy to `RollingUpdate`.

That's a code change (the persistence layer), tracked as a future enhancement — the SQLite single-replica setup above is the supported v1 for AKS.
