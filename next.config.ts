import path from "path";
import { execSync } from "child_process";
import type { NextConfig } from "next";

// Identifies exactly which deploy is running, so a long-lived client (an
// Electron window kept open across "turning it off and on," a browser tab
// left open for hours) can tell it's stale and reload itself — see
// lib/build-id.ts. Falls back to a timestamp if git isn't available (e.g.
// a build from a tarball rather than a clone) so this never breaks a
// build, it just loses the "same commit = same id" property in that case.
const BUILD_ID = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: __dirname }).toString().trim();
  } catch {
    return `nogit-${Date.now()}`;
  }
})();

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: path.resolve(__dirname),
  },
  devIndicators: false,
  env: {
    HERMES_BUILD_ID: BUILD_ID,
  },
};

export default nextConfig;
