// Server-side backing store for cross-device chat sync (see
// lib/syncClientStorage.ts for the client half). File-backed rather than a
// real database: this app is single-tenant and runs as one `node server.js`
// process (the standalone build, per the hermes-web-app systemd unit) on a
// Tailscale-only host (same assumption already documented in
// lib/notify-broadcast.ts), so a JSON file plus an in-process write lock is
// enough — no concurrent-writer-across-processes case to handle.
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";

// Deliberately loose/untyped here — the server only stores and rebroadcasts
// opaque JSON produced by the client (see lib/store.ts's partialize), so it
// has no need to import ChatSession et al. and no coupling to their shape.
export interface SyncedState {
  sessions: unknown[];
  seenFollowUpCallIds: string[];
  phoneCalls: unknown;
  phoneCallsFetchedAt: number | null;
}

interface SyncFile {
  version: number;
  updatedAt: number;
  state: SyncedState;
}

// Confirmed via the hermes-web-app systemd unit: production runs
// `node server.js` with WorkingDirectory set to .next/standalone, which
// `next build` fully regenerates on every deploy — so process.cwd() alone
// is NOT safe here (unlike app/api/about/route.ts's package.json read,
// which happens to work either way since Next's standalone output also
// traces a copy of package.json into that same directory). SYNC_STORE_PATH
// must be set in that unit's Environment to an absolute path outside any
// build output (see the deploy notes) — this only falls back to cwd for
// local dev, where `next dev`/`next start` run from the repo root.
const STORE_PATH = process.env.SYNC_STORE_PATH ?? path.join(process.cwd(), "data", "sync-store.json");
const DATA_DIR = path.dirname(STORE_PATH);

// Guards reads/writes against interleaving within this one process — each
// call chains onto the previous one's completion rather than running
// concurrently.
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = lock.then(fn, fn);
  lock = result.catch(() => {});
  return result;
}

async function readFileRaw(): Promise<SyncFile | null> {
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as SyncFile;
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function readSyncState(): Promise<SyncFile | null> {
  return withLock(readFileRaw);
}

export type WriteResult =
  | { ok: true; version: number; updatedAt: number }
  | { ok: false; current: SyncFile | null };

export function writeSyncState(baseVersion: number, state: SyncedState): Promise<WriteResult> {
  return withLock(async () => {
    const current = await readFileRaw();
    const currentVersion = current?.version ?? 0;
    if (baseVersion !== currentVersion) {
      return { ok: false, current };
    }

    const next: SyncFile = { version: currentVersion + 1, updatedAt: Date.now(), state };
    await mkdir(DATA_DIR, { recursive: true });
    const tmpPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(next), "utf-8");
    await rename(tmpPath, STORE_PATH);

    return { ok: true, version: next.version, updatedAt: next.updatedAt };
  });
}
