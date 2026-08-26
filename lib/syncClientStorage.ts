// Client half of cross-device chat sync (server half: lib/sync-store.ts,
// lib/sync-broadcast.ts, app/api/sync/*). Wraps localStorage as a zustand
// `StateStorage` — getItem/setItem/removeItem stay a trivial passthrough
// so today's synchronous, no-flash hydration from localStorage is
// unchanged — while independently keeping a shared, 4-field subset of the
// persisted state (sessions, seenFollowUpCallIds, phoneCalls,
// phoneCallsFetchedAt) in sync with the server. Everything else persisted
// (activeSessionId, activeAgentId, sidebarCollapsed, voiceVolume, audio
// device ids) is per-device UI/hardware state, not shared history, and
// never leaves this browser.
//
// Doesn't import useChatStore directly (lib/store.ts imports THIS module
// for its `storage` option, so importing back would be circular) —
// instead exposes subscribeSyncUpdates, which lib/store.ts calls once
// right after creating the store to apply remote updates via setState.
import type { StateStorage } from "zustand/middleware";
import type { AgentId } from "./agents";
import type { ChatSession, ChatMessage, CallSummary } from "./store";
import { getDeletedIds } from "./sync-tombstones";

const STORE_KEY = "hermes-chat-store";
const MIGRATED_KEY = "hermes-chat-store-sync-migrated";
const DEBOUNCE_MS = 500;
const MAX_RETRIES = 3;

export interface SyncedFields {
  sessions: ChatSession[];
  seenFollowUpCallIds: string[];
  phoneCalls: CallSummary[] | null;
  phoneCallsFetchedAt: number | null;
}

interface PersistEnvelope {
  state: Record<string, unknown>;
  version: number;
}

type ApplyFn = (partial: Partial<SyncedFields>) => void;

let applyCallback: ApplyFn | null = null;
let pendingApply: Partial<SyncedFields> | null = null;

// A remote update can arrive (via the initial sync's own async work) before
// lib/store.ts has had a chance to call subscribeSyncUpdates — buffers it
// instead of dropping it.
function applyRemote(partial: Partial<SyncedFields>) {
  if (applyCallback) {
    applyCallback(partial);
  } else {
    pendingApply = { ...pendingApply, ...partial };
  }
}

export function subscribeSyncUpdates(cb: ApplyFn): () => void {
  applyCallback = cb;
  if (pendingApply) {
    cb(pendingApply);
    pendingApply = null;
  }
  return () => {
    if (applyCallback === cb) applyCallback = null;
  };
}

// ---- localStorage envelope helpers ----
// zustand's persist stores `{ state, version }` JSON under STORE_KEY.

function readEnvelope(): PersistEnvelope | null {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistEnvelope;
  } catch {
    return null;
  }
}

function extractSyncedFields(state: Record<string, unknown>): SyncedFields {
  return {
    sessions: Array.isArray(state.sessions) ? (state.sessions as ChatSession[]) : [],
    seenFollowUpCallIds: Array.isArray(state.seenFollowUpCallIds) ? (state.seenFollowUpCallIds as string[]) : [],
    phoneCalls: (state.phoneCalls as CallSummary[] | null) ?? null,
    phoneCallsFetchedAt: (state.phoneCallsFetchedAt as number | null) ?? null,
  };
}

function currentLocalSyncedFields(): SyncedFields {
  const envelope = readEnvelope();
  return extractSyncedFields(envelope?.state ?? {});
}

// Writes the given synced fields into whatever's currently in localStorage
// (rather than overwriting the whole envelope) so untouched, per-device
// fields (activeSessionId, sidebarCollapsed, etc.) are never disturbed,
// then applies the same fields to the live store via applyRemote. Used
// both for a real merge result and for the one-time reset's "adopt the
// shared state as-is" case.
function applySyncedFields(fields: Partial<SyncedFields>) {
  const envelope = readEnvelope();
  const state = { ...(envelope?.state ?? {}), ...fields };
  localStorage.setItem(STORE_KEY, JSON.stringify({ state, version: envelope?.version ?? 1 }));
  applyRemote(fields);
}

// ---- structural merge ----
// Union-based and monotonic-safe: applying a remote snapshot can never
// regress a message that's actively streaming locally (its content only
// grows while streaming, so "prefer longer" always keeps the live copy).

function mergeMessages(a: ChatMessage[], b: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  const order: string[] = [];
  const add = (m: ChatMessage) => {
    const existing = byId.get(m.id);
    if (!existing) {
      order.push(m.id);
      byId.set(m.id, m);
    } else if (m.content.length > existing.content.length) {
      byId.set(m.id, m);
    }
  };
  for (const m of a) add(m);
  for (const m of b) add(m);
  return order.map((id) => byId.get(id)!);
}

function mergeSession(a: ChatSession, b: ChatSession): ChatSession {
  const agentIds = new Set<AgentId>([
    ...(Object.keys(a.threads) as AgentId[]),
    ...(Object.keys(b.threads) as AgentId[]),
  ]);
  const threads: Partial<Record<AgentId, ChatMessage[]>> = {};
  for (const id of agentIds) {
    threads[id] = mergeMessages(a.threads[id] ?? [], b.threads[id] ?? []);
  }
  return {
    id: a.id,
    title: a.title !== "New session" ? a.title : b.title,
    createdAt: Math.min(a.createdAt, b.createdAt),
    threads,
    agentActivity: a.agentActivity.length >= b.agentActivity.length ? a.agentActivity : b.agentActivity,
  };
}

function mergeSessionLists(local: ChatSession[], remote: ChatSession[], excludeIds?: Set<string>): ChatSession[] {
  const byId = new Map<string, ChatSession>();
  const order: string[] = [];
  const addAll = (list: ChatSession[]) => {
    for (const s of list) {
      if (excludeIds?.has(s.id)) continue;
      const existing = byId.get(s.id);
      if (!existing) {
        order.push(s.id);
        byId.set(s.id, s);
      } else {
        byId.set(s.id, mergeSession(existing, s));
      }
    }
  };
  addAll(local);
  addAll(remote);
  return order.map((id) => byId.get(id)!).sort((x, y) => y.createdAt - x.createdAt);
}

// excludeIds is only ever passed on the 409-retry merge path (see
// pushToServer) — this is steady-state sync between two already-shared
// devices, not the one-time reset in runInitialSync (which discards a
// device's pre-sync history outright rather than merging it in).
function mergeSyncedFields(local: SyncedFields, remote: SyncedFields, excludeIds?: Set<string>): SyncedFields {
  const localFetched = local.phoneCallsFetchedAt ?? 0;
  const remoteFetched = remote.phoneCallsFetchedAt ?? 0;
  return {
    sessions: mergeSessionLists(local.sessions, remote.sessions, excludeIds),
    seenFollowUpCallIds: Array.from(new Set([...local.seenFollowUpCallIds, ...remote.seenFollowUpCallIds])),
    phoneCalls: remoteFetched > localFetched ? remote.phoneCalls : local.phoneCalls,
    phoneCallsFetchedAt: Math.max(localFetched, remoteFetched) || null,
  };
}

// ---- server I/O ----

interface ServerSyncResponse {
  version: number;
  updatedAt: number | null;
  state: SyncedFields | null;
}

async function fetchServerState(): Promise<ServerSyncResponse> {
  const res = await fetch("/api/sync");
  return res.json();
}

async function putServerState(
  baseVersion: number,
  state: SyncedFields
): Promise<{ ok: true; version: number } | { ok: false; version: number; state: SyncedFields | null }> {
  const res = await fetch("/api/sync", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseVersion, state }),
  });
  const data = await res.json();
  if (res.ok) return { ok: true, version: data.version };
  return { ok: false, version: data.version ?? baseVersion, state: data.state ?? null };
}

let lastKnownVersion = 0;
let migrationPromise: Promise<void> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

async function pushToServer(attempt = 0): Promise<void> {
  const fields = currentLocalSyncedFields();
  const result = await putServerState(lastKnownVersion, fields);
  if (result.ok) {
    lastKnownVersion = result.version;
    return;
  }

  lastKnownVersion = result.version;
  if (attempt >= MAX_RETRIES || !result.state) return;

  // Conflict: another device's write landed first. Merge, excluding any
  // session this device deleted (see lib/sync-tombstones.ts) so a losing
  // race can't resurrect a deletion — every other kind of divergence is
  // safe to union.
  const merged = mergeSyncedFields(fields, result.state, getDeletedIds());
  applySyncedFields(merged);
  await pushToServer(attempt + 1);
}

function scheduleServerWrite() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void (async () => {
      if (migrationPromise) await migrationPromise;
      await pushToServer();
    })();
  }, DEBOUNCE_MS);
}

// ---- live push (SSE) ----

// Registered by lib/store.ts right after creating useChatStore (same
// pattern as subscribeSyncUpdates, and for the same reason: this module
// can't import useChatStore directly without creating a circular import).
// Lets reconcileFromServer defer applying a remote snapshot while this
// device is itself actively streaming, purely to avoid a visual flicker —
// the merge itself is already safe to apply mid-stream.
let streamingCheck: (() => boolean) | null = null;
export function registerStreamingCheck(fn: () => boolean): void {
  streamingCheck = fn;
}

function isStreamingLocally(): boolean {
  return streamingCheck?.() ?? false;
}

function reconcileFromServer() {
  void (async () => {
    // Let the one-time migration (if still in flight) finish and apply
    // first, so a live push received right at startup can't race it —
    // without this, both could call applySyncedFields concurrently with
    // stale views of lastKnownVersion/localStorage.
    if (migrationPromise) await migrationPromise;
    const server = await fetchServerState();
    if (server.version <= lastKnownVersion || !server.state) return;
    lastKnownVersion = server.version;

    const apply = () => {
      const merged = mergeSyncedFields(currentLocalSyncedFields(), server.state!);
      applySyncedFields(merged);
    };

    if (isStreamingLocally()) {
      // Defer until this device's own stream goes idle — belt-and-suspenders
      // on top of the merge (which is already safe to apply mid-stream)
      // purely to avoid a visual flicker during genuine concurrent activity.
      const check = () => {
        if (isStreamingLocally()) {
          setTimeout(check, 500);
        } else {
          apply();
        }
      };
      check();
    } else {
      apply();
    }
  })();
}

let sseStarted = false;
function ensureSSE() {
  if (sseStarted || typeof window === "undefined" || typeof EventSource === "undefined") return;
  sseStarted = true;
  const source = new EventSource("/api/sync/events");
  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as { version?: number };
      if (typeof data.version === "number" && data.version > lastKnownVersion) {
        reconcileFromServer();
      }
    } catch {
      // Ignore malformed/keepalive frames.
    }
  };
}

// ---- one-time reset-to-shared-session + ongoing catch-up ----

const EMPTY_SYNCED_FIELDS: SyncedFields = {
  sessions: [],
  seenFollowUpCallIds: [],
  phoneCalls: null,
  phoneCallsFetchedAt: null,
};

function runInitialSync(): Promise<void> {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    ensureSSE();

    let server: ServerSyncResponse;
    try {
      server = await fetchServerState();
    } catch {
      return; // Offline — keep working from localStorage only; next debounced write retries.
    }
    lastKnownVersion = server.version;

    const alreadyMigrated = localStorage.getItem(MIGRATED_KEY) === "1";

    if (!alreadyMigrated) {
      // One-time reset: every device was independently accumulating its
      // own separate history before cross-device sync existed. Per an
      // explicit decision, that's discarded outright rather than merged —
      // this device adopts whatever's already shared (empty, if no device
      // has ever connected yet), not a union of the two.
      const shared = server.state ?? EMPTY_SYNCED_FIELDS;
      applySyncedFields(shared);
      if (!server.state) {
        // First device to ever connect — its (now-emptied) state becomes
        // the server's initial seed, so the version counter starts moving.
        const result = await putServerState(0, shared);
        if (result.ok) lastKnownVersion = result.version;
      }
      localStorage.setItem(MIGRATED_KEY, "1");
      return;
    }

    // Already migrated — just catch up on anything missed while this tab
    // was closed (union-merge, safe even if nothing actually changed; this
    // is normal steady-state sync, not the one-time reset above).
    if (server.state) {
      const merged = mergeSyncedFields(currentLocalSyncedFields(), server.state);
      applySyncedFields(merged);
    }
  })();
  return migrationPromise;
}

// Lets a caller (lib/store.ts's sendMessage/askEva) wait for the one-time
// migration to settle before creating a new session — without this, a
// message sent in the brief window between page load and this resolving
// gets silently erased when the migration's applySyncedFields finally
// lands and overwrites `sessions` with the (older) snapshot it fetched
// before that message ever existed. Resolves immediately once sync has
// never been initialized at all (shouldn't happen in practice — store.ts
// always uses createSyncStorage — but avoids ever hanging on a null promise).
export function whenSyncReady(): Promise<void> {
  return migrationPromise ?? Promise.resolve();
}

// ---- the StateStorage zustand's persist middleware actually uses ----

export function createSyncStorage(): StateStorage {
  if (typeof window !== "undefined") {
    void runInitialSync();
  }
  return {
    getItem: (name) => localStorage.getItem(name),
    setItem: (name, value) => {
      localStorage.setItem(name, value);
      scheduleServerWrite();
    },
    removeItem: (name) => localStorage.removeItem(name),
  };
}
