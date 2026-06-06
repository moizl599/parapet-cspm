# Security

Parapet is a **local-first, read-only** tool. It scans an AWS account with Prowler, interprets the findings with a **local** LLM (Ollama), and renders a remediation report. This document covers the credential model, the least-privilege IAM policy, the assume-role upgrade path, and the one notable infrastructure tradeoff (the Docker socket mount).

## Security model at a glance

- **Read-only.** The app never mutates cloud resources. It does not import any AWS SDK — it only shells out to the official `prowlercloud/prowler` container, which runs in read/audit mode. There is no code path that creates, modifies, or deletes AWS resources.
- **Local-first.** The LLM runs locally via Ollama. Findings never leave the machine; nothing is sent to a third-party API.
- **Secrets stay server-side.** AWS credentials and the Ollama endpoint are read only in server-side code and are never shipped to the browser.

### How these properties are enforced (and verified)

| Property | Enforcement | Verification |
| --- | --- | --- |
| No mutating AWS calls | No AWS SDK is a dependency; scanning is delegated to the read-only Prowler container | `grep` for `aws-sdk`/`@aws-sdk` returns nothing; `package.json` has no AWS SDK |
| Creds only server-side | Read solely in `src/lib/config.ts`; credential/endpoint modules (`config`, `ollama`, `prowler`, `scan-store`, `scan-runner`, `analyze`) `import "server-only"` (build-time tripwire) | No client component value-imports a server module; production client bundle (`.next/static`) contains no `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`getAwsCredentials`/`child_process`/`11434` |
| Creds never written/logged | `prowler/run-scan.sh` passes creds with `docker run -e VAR` (name only) and guards with `${VAR:?msg}` (prints the variable *name*, never the value) | The script never `echo`s a secret value or writes creds to disk |
| Creds not committed | `.env` is gitignored; `.env.example` documents the variables | — |

## Least-privilege IAM for scan credentials

Prowler needs **read-only / audit** access. AWS provides two managed policies that together cover what Prowler reads:

- **`SecurityAudit`** (`arn:aws:iam::aws:policy/SecurityAudit`) — read access to security configuration across services.
- **`ViewOnlyAccess`** (`arn:aws:iam::aws:policy/job-function/ViewOnlyAccess`) — list/describe/get across services.

Neither grants any create/update/delete permission, so credentials scoped to these policies **cannot modify resources** even if misused.

### Create a read-only IAM user

**Console**
1. IAM → Users → **Create user** (e.g. `cspm-analyzer-readonly`). Do **not** enable console access.
2. **Set permissions → Attach policies directly** → attach `SecurityAudit` **and** `ViewOnlyAccess`.
3. Create the user, then **Security credentials → Create access key** → use case *Application running outside AWS*.
4. Copy the Access key ID and Secret access key into `.env`:
   ```
   AWS_ACCESS_KEY_ID=AKIA...
   AWS_SECRET_ACCESS_KEY=...
   AWS_DEFAULT_REGION=us-east-1
   ```

**CLI** (run by an admin with IAM permissions)
```bash
aws iam create-user --user-name cspm-analyzer-readonly
aws iam attach-user-policy --user-name cspm-analyzer-readonly \
  --policy-arn arn:aws:iam::aws:policy/SecurityAudit
aws iam attach-user-policy --user-name cspm-analyzer-readonly \
  --policy-arn arn:aws:iam::aws:policy/job-function/ViewOnlyAccess
aws iam create-access-key --user-name cspm-analyzer-readonly
```

### Good hygiene
- Treat the secret like a password: keep it only in the gitignored `.env`, rotate periodically, and delete the key when you stop using the tool.
- Prefer a dedicated user used **only** by this tool, so its activity is easy to audit and revoke.

## Assume-role (supported, recommended)

Long-lived access keys are convenient locally but not ideal. The cleaner model — now supported — is to **assume a read-only role** instead of holding static keys:

1. Create an IAM **role** (e.g. `ProwlerScanRole`) with the same two managed policies attached.
2. Give it a trust policy allowing your principal to assume it, ideally gated by an **external ID**:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "AWS": "arn:aws:iam::<YOUR_ACCOUNT_ID>:user/cspm-analyzer-readonly" },
       "Action": "sts:AssumeRole",
       "Condition": { "StringEquals": { "sts:ExternalId": "<RANDOM_SHARED_SECRET>" } }
     }]
   }
   ```
3. Prowler performs the STS `AssumeRole` itself — so Parapet stays AWS-SDK-free and the database never stores an AWS secret. Register the **role ARN + external ID** in the **Environments** UI (or use `scripts/aws/create-scan-role.sh`); this also enables **cross-account** scanning from a single base identity. See [docs/AWS_SETUP.md](docs/AWS_SETUP.md).

Benefits: short-lived STS credentials instead of long-lived keys, per-scan scoping, and an external ID to prevent the confused-deputy problem.

## Infrastructure tradeoff: the Docker socket mount

The `web` container launches Prowler on the **host** Docker daemon by mounting `/var/run/docker.sock`. Only the Docker CLI is installed in the runtime image; the daemon is the host's.

**The tradeoff:** access to the host Docker socket is effectively **host-level control** — a process that can talk to the daemon can start privileged containers, bind-mount host paths, and so on. This is a deliberate, documented choice:

- **Acceptable** for this tool's intended use: a **local, single-user** machine where the operator already controls Docker. The whole point is to spawn read-only Prowler scans on demand.
- **Not acceptable** for a **shared, multi-tenant, hosted, or internet-exposed** deployment. Do not ship this topology to such environments. If you need that, run Prowler out-of-process behind a constrained job runner (e.g. a sidecar with a scoped API, a rootless/socket-proxy with an allow-list, or a separate scan service) instead of mounting the raw socket.

The web process itself is read-only toward AWS regardless of the socket — the socket concern is about the **host**, not your cloud account.

## Reporting

This is a local tool with no network listener beyond `localhost`. If you find a security issue in the code, open an issue or contact the maintainer.
