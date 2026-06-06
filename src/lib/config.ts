/**
 * Typed environment configuration loader.
 *
 * SERVER-SIDE ONLY. This module reads credentials and other sensitive
 * configuration from `process.env`. It must never be imported into a Client
 * Component or otherwise shipped to the browser. See CLAUDE.md ("Conventions").
 *
 * AWS credentials are validated *lazily* — only when a scan is actually run —
 * so the app (UI + API) can boot without any cloud credentials configured.
 */
import "server-only"; // build-time tripwire: importing this from client code fails the build

export interface OllamaConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  /** Model tag served by Ollama, e.g. llama3.1:8b */
  model: string;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Resolved from AWS_REGION, falling back to AWS_DEFAULT_REGION. */
  region: string;
}

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_OLLAMA_MODEL = "llama3.1:8b";

/**
 * Returns Ollama connection settings. These have sensible local-first defaults,
 * so this never throws — it is safe to call at boot.
 */
export function getOllamaConfig(): OllamaConfig {
  return {
    baseUrl: process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
    model: process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL,
  };
}

/**
 * Reads and validates the read-only AWS credentials used to drive a Prowler
 * scan. Call this only at the point a scan is initiated — NOT at module load —
 * so the app can run without credentials.
 *
 * @throws {Error} with a clear, actionable message listing every missing var.
 */
export function getAwsCredentials(): AwsCredentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  // AWS_REGION wins; AWS_DEFAULT_REGION is the conventional fallback.
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

  if (!accessKeyId || !secretAccessKey || !region) {
    const missing: string[] = [];
    if (!accessKeyId) missing.push("AWS_ACCESS_KEY_ID");
    if (!secretAccessKey) missing.push("AWS_SECRET_ACCESS_KEY");
    if (!region) missing.push("AWS_REGION (or AWS_DEFAULT_REGION)");

    throw new Error(
      `Cannot start AWS scan: missing required environment variable(s): ` +
        `${missing.join(", ")}. Set them in your .env file (see .env.example). ` +
        `Use read-only credentials — this tool never modifies cloud resources.`,
    );
  }

  return { accessKeyId, secretAccessKey, region };
}
