// Set in next.config.ts's `env` field to the git commit checked out at
// build time — Next.js substitutes every `process.env.HERMES_BUILD_ID`
// reference (client AND server code alike) with that literal string at
// build time, so this constant is identical everywhere in one deploy and
// different from the previous one. Used to detect a stale long-lived
// client (see lib/syncClientStorage.ts's build-id check) — not a security
// token, just a cache-busting marker.
export const BUILD_ID = process.env.HERMES_BUILD_ID ?? "dev";
