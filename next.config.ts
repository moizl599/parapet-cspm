import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle at `.next/standalone/server.js` so the
  // Docker runtime image can run `node server.js` without installing
  // node_modules. See the multi-stage Dockerfile.
  output: "standalone",
  // better-sqlite3 is a native module — keep it external (not bundled) so its
  // compiled .node binary is traced into the standalone output correctly.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
