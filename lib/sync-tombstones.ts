// Short-lived record of session ids deleted locally, used only by the
// 409-retry merge path in lib/syncClientStorage.ts. Without this, a device
// that deletes a session can have it silently resurrected: if another
// device's write wins a race and its snapshot still includes that session,
// a naive union-merge on the losing device's retry would add it right back.
// Never persisted (a delete is never supposed to "come back" after a
// reload, so there's nothing to remember past the process's lifetime) and
// irrelevant to the one-time reset in runInitialSync (lib/syncClientStorage.ts),
// which discards a device's pre-sync history outright rather than merging
// it in — there's nothing to protect there either way.
const TTL_MS = 2 * 60 * 1000;

const deletedAt = new Map<string, number>();

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, ts] of deletedAt) {
    if (ts < cutoff) deletedAt.delete(id);
  }
}

export function markDeleted(ids: string[]) {
  const now = Date.now();
  for (const id of ids) deletedAt.set(id, now);
  sweep();
}

export function getDeletedIds(): Set<string> {
  sweep();
  return new Set(deletedAt.keys());
}
