// Registers the "@/..." alias resolution hook for plain `node` runs.
// Used via `node --import ./scripts/register-alias.mjs ...`.
import { register } from "node:module";

register("./alias-hooks.mjs", import.meta.url);
