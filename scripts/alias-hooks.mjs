// Node ESM resolution hook that maps the project's "@/..." import alias to
// files under ./src, so plain `node` (tests, check:ollama) resolves the same
// imports Next.js/tsc resolve via tsconfig "paths". Bare ".ts" is appended when
// the alias target has no extension (Node ESM does not do extensionless lookup).
import path from "node:path";
import { pathToFileURL } from "node:url";

const SRC_DIR = path.resolve(process.cwd(), "src");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@" || specifier.startsWith("@/")) {
    let target = path.join(SRC_DIR, specifier.slice(2));
    if (!path.extname(target)) target += ".ts";
    return nextResolve(pathToFileURL(target).href, context);
  }
  return nextResolve(specifier, context);
}
