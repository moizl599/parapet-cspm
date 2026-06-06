"use client";

/**
 * Environments management: list AWS accounts to scan as cards, and add / edit /
 * delete them. SECURITY: the external ID is a secret — it is never returned from
 * the server (DTOs only carry `hasExternalId`). The form therefore only ever
 * reveals what the user just typed (password input + show/hide); an existing
 * secret is shown as "stored" and left unchanged unless re-entered.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  EyeIcon,
  EyeOffIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  ServerIcon,
  TrashIcon,
  XIcon,
} from "@/components/icons";
import { Button, Card, Pill, Skeleton } from "@/components/ui/primitives";
import { EmptyState, ErrorState } from "@/components/states";
import { useApp } from "@/components/app-context";
import { postureBand } from "@/lib/posture";
import {
  createEnvironment,
  deleteEnvironment,
  startScan,
  testConnection,
  updateEnvironment,
  type EnvironmentDto,
  type EnvironmentInput,
  type TestConnectionResult,
} from "@/lib/api-client";
import { isValidRegion, isValidRoleArn } from "@/lib/aws-validate";

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function EnvironmentsPage() {
  const { environments, envError, refreshEnvironments, selectEnvironment } =
    useApp();
  const router = useRouter();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EnvironmentDto | null>(null);
  const [deleting, setDeleting] = useState<EnvironmentDto | null>(null);
  const [scanningId, setScanningId] = useState<string | null>(null);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (env: EnvironmentDto) => {
    setEditing(env);
    setFormOpen(true);
  };

  const scanNow = useCallback(
    async (env: EnvironmentDto) => {
      setScanningId(env.id);
      try {
        const { scanId } = await startScan(env.id);
        if (typeof window !== "undefined") {
          localStorage.setItem(`cspm:activeScan:${env.id}`, scanId);
        }
        selectEnvironment(env.id);
        router.push("/");
      } catch {
        setScanningId(null);
      }
    },
    [router, selectEnvironment],
  );

  return (
    <main className="mx-auto max-w-7xl px-5 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-fg">Environments</h1>
          <p className="mt-1 text-sm text-muted">
            AWS accounts this tool can scan. Scans are read-only; analysis stays
            on this machine.
          </p>
        </div>
        {environments && environments.length > 0 && (
          <Button onClick={openCreate} icon={<PlusIcon className="size-4" />}>
            Add environment
          </Button>
        )}
      </div>

      {envError && (
        <ErrorState
          title="Couldn’t load environments"
          message={envError}
          onRetry={() => void refreshEnvironments()}
        />
      )}

      {/* Loading */}
      {!envError && environments === null && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mt-2 h-3 w-2/3" />
              <Skeleton className="mt-5 h-9 w-full" />
            </Card>
          ))}
        </div>
      )}

      {/* Empty */}
      {!envError && environments && environments.length === 0 && (
        <EmptyState
          icon={<ServerIcon className="size-6" />}
          title="Add your first environment"
          description="Connect an AWS account to scan. Use this machine's base scanner identity, or assume a read-only role in a target account."
          action={
            <Button onClick={openCreate} icon={<PlusIcon className="size-4" />}>
              Add environment
            </Button>
          }
        />
      )}

      {/* Cards */}
      {!envError && environments && environments.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {environments.map((env) => (
            <EnvCard
              key={env.id}
              env={env}
              scanning={scanningId === env.id}
              onScan={() => scanNow(env)}
              onEdit={() => openEdit(env)}
              onDelete={() => setDeleting(env)}
            />
          ))}
        </div>
      )}

      {formOpen && (
        <EnvFormModal
          editing={editing}
          onClose={() => setFormOpen(false)}
          onSaved={async () => {
            setFormOpen(false);
            await refreshEnvironments();
          }}
        />
      )}

      {deleting && (
        <DeleteDialog
          env={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null);
            await refreshEnvironments();
          }}
        />
      )}
    </main>
  );
}

/* --------------------------------- Card --------------------------------- */

function EnvCard({
  env,
  scanning,
  onScan,
  onEdit,
  onDelete,
}: {
  env: EnvironmentDto;
  scanning: boolean;
  onScan: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const band = postureBand(env.lastPostureScore);
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-fg">{env.name}</h3>
          <p className="mt-0.5 truncate font-mono text-xs text-faint">
            {env.targetAccountId ?? "account id unknown"}
          </p>
        </div>
        <Pill>{env.authMode === "role" ? "Assume role" : "Base"}</Pill>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-y-2 text-xs">
        <dt className="text-faint">Regions</dt>
        <dd className="text-right text-muted">
          {env.regions.length ? env.regions.join(", ") : "All regions"}
        </dd>
        <dt className="text-faint">Last scan</dt>
        <dd className="text-right text-muted">{formatDate(env.lastScanAt)}</dd>
        <dt className="text-faint">Posture</dt>
        <dd className="flex items-center justify-end gap-1.5 text-right">
          <span className={`size-2 rounded-full ${band.dot}`} aria-hidden />
          <span className={`font-medium ${band.className}`}>
            {env.lastPostureScore != null ? `${env.lastPostureScore}` : "—"}{" "}
            {band.label}
          </span>
        </dd>
      </dl>

      <div className="mt-5 flex items-center gap-2 border-t border-border pt-4">
        <Button
          onClick={onScan}
          loading={scanning}
          icon={!scanning ? <PlayIcon className="size-4" /> : undefined}
          className="flex-1"
        >
          {scanning ? "Starting…" : "Scan now"}
        </Button>
        <Button
          variant="secondary"
          onClick={onEdit}
          aria-label={`Edit ${env.name}`}
          className="px-2.5"
        >
          <PencilIcon className="size-4" />
        </Button>
        <Button
          variant="secondary"
          onClick={onDelete}
          aria-label={`Delete ${env.name}`}
          className="px-2.5 text-muted hover:text-critical"
        >
          <TrashIcon className="size-4" />
        </Button>
      </div>
    </Card>
  );
}

/* ------------------------------- Form modal ------------------------------- */

function EnvFormModal({
  editing,
  onClose,
  onSaved,
}: {
  editing: EnvironmentDto | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const titleId = useId();
  const isEdit = editing !== null;

  const [name, setName] = useState(editing?.name ?? "");
  const [authMode, setAuthMode] = useState<"role" | "base">(
    editing?.authMode ?? "base",
  );
  const [targetAccountId, setTargetAccountId] = useState(
    editing?.targetAccountId ?? "",
  );
  const [roleArn, setRoleArn] = useState(editing?.roleArn ?? "");
  const [externalId, setExternalId] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [regions, setRegions] = useState((editing?.regions ?? []).join(", "));

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Focus first field on open; close on Escape.
  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Re-typing the secret invalidates a prior test result.
  const onSecretChange = (v: string) => {
    setExternalId(v);
    setTestResult(null);
  };

  const regionList = regions
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const badRegions = regionList.filter((r) => !isValidRegion(r));

  const roleArnValid = authMode !== "role" || isValidRoleArn(roleArn.trim());
  const canTest =
    authMode === "role" &&
    isValidRoleArn(roleArn.trim()) &&
    externalId.trim().length >= 2;

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testConnection(roleArn.trim(), externalId.trim()));
    } catch (e) {
      setTestResult({
        ok: false,
        error: e instanceof Error ? e.message : "Test failed.",
      });
    } finally {
      setTesting(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) return setError("Name is required.");
    if (authMode === "role") {
      if (!isValidRoleArn(roleArn.trim())) {
        return setError(
          "Enter a valid role ARN (arn:aws:iam::<account-id>:role/<name>).",
        );
      }
      if (!isEdit && externalId.trim().length < 2) {
        return setError("An external ID is required for assume-role mode.");
      }
    }
    if (badRegions.length) {
      return setError(`Invalid region(s): ${badRegions.join(", ")}`);
    }

    const input: EnvironmentInput = {
      name: name.trim(),
      authMode,
      targetAccountId: targetAccountId.trim() || null,
      roleArn: authMode === "role" ? roleArn.trim() : null,
      regions: regionList,
    };
    // Only send the secret if the user actually typed one.
    if (externalId.trim()) input.externalId = externalId.trim();

    setSaving(true);
    try {
      if (isEdit) await updateEnvironment(editing!.id, input);
      else await createEnvironment(input);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="animate-rise my-auto w-full max-w-lg rounded-2xl border border-border bg-surface shadow-2xl shadow-black/50"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 id={titleId} className="text-sm font-semibold text-fg">
            {isEdit ? `Edit ${editing!.name}` : "Add environment"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-4">
          <Field label="Name" htmlFor="env-name" required>
            <input
              ref={firstFieldRef}
              id="env-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production"
              className={inputCls}
              autoComplete="off"
            />
          </Field>

          <Field label="Authentication" htmlFor="env-auth">
            <div className="grid grid-cols-2 gap-2" id="env-auth" role="radiogroup" aria-label="Authentication mode">
              <ModeButton
                active={authMode === "base"}
                onClick={() => {
                  setAuthMode("base");
                  setTestResult(null);
                }}
                title="This machine"
                desc="Use the base scanner identity"
              />
              <ModeButton
                active={authMode === "role"}
                onClick={() => setAuthMode("role")}
                title="Assume role"
                desc="Read-only role in a target account"
              />
            </div>
          </Field>

          <Field label="Target account ID" htmlFor="env-account" hint="Optional — shown on the card.">
            <input
              id="env-account"
              type="text"
              inputMode="numeric"
              value={targetAccountId}
              onChange={(e) => setTargetAccountId(e.target.value)}
              placeholder="123456789012"
              className={inputCls}
              autoComplete="off"
            />
          </Field>

          {authMode === "role" && (
            <>
              <Field label="Role ARN" htmlFor="env-arn" required>
                <input
                  id="env-arn"
                  type="text"
                  value={roleArn}
                  onChange={(e) => {
                    setRoleArn(e.target.value);
                    setTestResult(null);
                  }}
                  placeholder="arn:aws:iam::123456789012:role/SecurityAudit"
                  className={`${inputCls} font-mono text-xs ${
                    roleArn && !roleArnValid ? "border-critical/60" : ""
                  }`}
                  autoComplete="off"
                  aria-invalid={roleArn ? !roleArnValid : undefined}
                />
              </Field>

              <Field
                label="External ID"
                htmlFor="env-extid"
                required={!isEdit}
                hint={
                  isEdit
                    ? "A secret is stored — leave blank to keep it, or type a new one to replace it."
                    : "Shared secret required by the role's trust policy."
                }
              >
                <div className="relative">
                  <input
                    id="env-extid"
                    type={showSecret ? "text" : "password"}
                    value={externalId}
                    onChange={(e) => onSecretChange(e.target.value)}
                    placeholder={
                      isEdit && editing!.hasExternalId
                        ? "•••••••• stored"
                        : "external id"
                    }
                    className={`${inputCls} pr-10`}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((v) => !v)}
                    aria-label={showSecret ? "Hide external ID" : "Show external ID"}
                    aria-pressed={showSecret}
                    className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted transition-colors hover:text-fg"
                  >
                    {showSecret ? (
                      <EyeOffIcon className="size-4" />
                    ) : (
                      <EyeIcon className="size-4" />
                    )}
                  </button>
                </div>
              </Field>

              <Field
                label="Regions"
                htmlFor="env-regions"
                hint="Comma-separated, e.g. us-east-1, eu-west-1. Leave blank to scan all."
              >
                <input
                  id="env-regions"
                  type="text"
                  value={regions}
                  onChange={(e) => setRegions(e.target.value)}
                  placeholder="us-east-1, eu-west-1"
                  className={`${inputCls} ${
                    badRegions.length ? "border-critical/60" : ""
                  }`}
                  autoComplete="off"
                />
              </Field>

              {/* Test connection */}
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2/50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted">
                    Verify the base identity can assume this role.
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={runTest}
                    loading={testing}
                    disabled={!canTest}
                    className="shrink-0 px-3 py-1.5 text-xs"
                  >
                    Test connection
                  </Button>
                </div>
                {testResult && (
                  <div
                    role="status"
                    aria-live="polite"
                    className={`flex items-start gap-2 text-xs ${
                      testResult.ok ? "text-ok" : "text-high"
                    }`}
                  >
                    {testResult.ok ? (
                      <>
                        <CheckCircleIcon className="mt-0.5 size-4 shrink-0" />
                        <span className="text-muted">
                          Connected — resolved account{" "}
                          <span className="font-mono font-medium text-ok">
                            {testResult.account_id}
                          </span>
                        </span>
                      </>
                    ) : (
                      <>
                        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                        <span className="text-muted">
                          {testResult.error ?? "Could not assume the role."}
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {authMode === "base" && (
            <p className="rounded-lg border border-border bg-surface-2/50 p-3 text-xs leading-relaxed text-muted">
              Uses this machine&apos;s base scanner identity — the read-only AWS
              credentials configured in the server environment. No role is
              assumed.
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-critical/30 bg-critical/8 px-3 py-2 text-sm text-critical"
            >
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              {isEdit ? "Save changes" : "Add environment"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint transition-colors focus-visible:border-primary focus-visible:outline-none";

function Field({
  label,
  htmlFor,
  required,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted">
        {label}
        {required && <span className="ml-0.5 text-critical">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-faint">{hint}</p>}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors ${
        active
          ? "border-primary/60 bg-primary/10"
          : "border-border-strong bg-surface-2 hover:bg-surface-3"
      }`}
    >
      <span className="text-sm font-medium text-fg">{title}</span>
      <span className="text-[11px] leading-tight text-faint">{desc}</span>
    </button>
  );
}

/* ------------------------------ Delete dialog ------------------------------ */

function DeleteDialog({
  env,
  onClose,
  onDeleted,
}: {
  env: EnvironmentDto;
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  const titleId = useId();
  const [deletingState, setDeletingState] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const confirm = async () => {
    setDeletingState(true);
    setError(null);
    try {
      await deleteEnvironment(env.id);
      await onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete.");
      setDeletingState(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="animate-rise w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-2">
          <AlertTriangleIcon className="size-5 text-critical" />
          <h2 id={titleId} className="text-sm font-semibold text-fg">
            Delete “{env.name}”?
          </h2>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          This removes the environment and its scan history (findings and
          analyses). It does not touch anything in AWS. This can’t be undone.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-critical">
            {error}
          </p>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={confirm}
            loading={deletingState}
            className="bg-critical text-white hover:bg-critical/85 focus-visible:bg-critical/85"
          >
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}
