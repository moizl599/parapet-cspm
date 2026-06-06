# AWS Setup Guide

Parapet only ever needs **read-only** access to your AWS account. The recommended setup uses the two AWS-managed policies Prowler recommends — `SecurityAudit` and `ViewOnlyAccess` — neither of which grants any create/update/delete permission. So even if the credentials were misused, they **cannot modify resources**.

There are two supported authentication models:

| Model | When to use | What's stored |
|---|---|---|
| **IAM access keys** | Simplest. Single account, local use. | Read-only keys in your gitignored `.env`. |
| **Assume-role** (recommended) | Multiple accounts, or to avoid long-lived keys. | Only a role ARN + external ID (no secrets). Register it in the UI. |

Helper scripts for both live in [`scripts/aws/`](../scripts/aws). Run them in **AWS CloudShell** (or any shell with admin AWS CLI access).

---

## Option 1 — Read-only IAM access keys

### Using the helper script

```bash
bash scripts/aws/create-scan-user.sh
```

It creates a `parapet-scanner` user, attaches `SecurityAudit` + `ViewOnlyAccess`, creates an access key, and prints the four `.env` lines. **Copy the secret immediately — it's shown only once.**

### Manually (console)

1. **IAM → Users → Create user** (e.g. `parapet-scanner`). Do **not** enable console access.
2. **Set permissions → Attach policies directly** → attach **`SecurityAudit`** and **`ViewOnlyAccess`**.
3. Create the user → **Security credentials → Create access key** → *Application running outside AWS*.
4. Put the keys in `.env`:
   ```
   AWS_ACCESS_KEY_ID=AKIA...
   AWS_SECRET_ACCESS_KEY=...
   AWS_DEFAULT_REGION=us-east-1
   AWS_REGION=us-east-1
   ```

### Manually (CLI)

```bash
aws iam create-user --user-name parapet-scanner
aws iam attach-user-policy --user-name parapet-scanner \
  --policy-arn arn:aws:iam::aws:policy/SecurityAudit
aws iam attach-user-policy --user-name parapet-scanner \
  --policy-arn arn:aws:iam::aws:policy/job-function/ViewOnlyAccess
aws iam create-access-key --user-name parapet-scanner
```

Then restart the web container so it picks up the new env: `docker compose up -d web`.

---

## Option 2 — Assume-role (recommended)

With assume-role, Parapet's base identity assumes a read-only role at scan time (Prowler does the STS `AssumeRole` itself). The database stores only the **role ARN** and **external ID** — never a secret. This is also how you scan **multiple accounts** from one base identity.

### Using the helper script

First create the base scanner identity (Option 1 above), then:

```bash
bash scripts/aws/create-scan-role.sh
```

It creates a `parapet-scan-role` trusted by `parapet-scanner` (gated by a generated external ID), attaches the read-only policies plus a small additions policy for full-coverage checks, grants the scanner permission to assume it, and prints the **Role ARN** and **External ID**.

### Register it in the UI

1. Open Parapet → **Environments → Add environment**.
2. Name it, choose **Assume role**, and paste the **Role ARN**, **External ID**, and optional regions.
3. Click **Test connection** — it should resolve to the target account ID.
4. Save, then **Scan now**.

### The trust policy (for reference)

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::<YOUR_ACCOUNT_ID>:user/parapet-scanner" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "sts:ExternalId": "<RANDOM_SHARED_SECRET>" } }
  }]
}
```

The external ID prevents the confused-deputy problem; short-lived STS credentials replace long-lived keys.

---

## A note on coverage

`SecurityAudit` + `ViewOnlyAccess` cover the large majority of Prowler's checks, but a handful of niche checks (e.g. EBS default encryption) need a few extra read-only permissions AWS doesn't include in the managed policies. The `create-scan-role.sh` script adds these as a small `parapet-additions` inline policy (strictly `Get`/`List`). Without them, those checks simply show as "could not retrieve" in the scan log — they don't produce wrong results.

---

## Optional — validate against a deliberately-misconfigured sandbox

To see Parapet light up with real findings without touching anything important, you can plant a handful of intentional misconfigurations in a **throwaway sandbox account**:

```bash
bash scripts/aws/test-lab-setup.sh     # creates: open SG, public S3 bucket, EBS encryption off, IAM user w/o MFA
# ... run a scan in Parapet ...
bash scripts/aws/test-lab-teardown.sh  # removes everything, restores original settings
```

> ⚠️ **Sandbox accounts only.** These scripts intentionally create insecure resources. Never run them in an account with real data. The S3 bucket is kept empty, everything is tagged `Project=parapet-test`, and teardown reverses all of it.

---

## Good hygiene

- Keep the secret only in the gitignored `.env`; rotate periodically and delete the key when you stop using the tool.
- Use a dedicated identity used **only** by Parapet, so its activity is easy to audit and revoke.
- Prefer assume-role over long-lived keys where you can.

For the full security model and the Docker-socket tradeoff, see [SECURITY.md](../SECURITY.md).
