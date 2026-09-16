import { NextRequest } from "next/server";
import { readSyncState, writeSyncState, type SyncedState } from "@/lib/sync-store";
import { broadcast } from "@/lib/sync-broadcast";
import { BUILD_ID } from "@/lib/build-id";

export const runtime = "nodejs";

export async function GET() {
  const current = await readSyncState();
  if (!current) {
    return Response.json({ version: 0, updatedAt: null, state: null });
  }
  return Response.json(current);
}

function isSyncedState(value: unknown): value is SyncedState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SyncedState>;
  return (
    Array.isArray(v.sessions) &&
    Array.isArray(v.seenFollowUpCallIds) &&
    (v.phoneCallsFetchedAt === null || typeof v.phoneCallsFetchedAt === "number") &&
    Array.isArray(v.feedbackItems) &&
    (v.seenAppVersion === undefined || v.seenAppVersion === null || typeof v.seenAppVersion === "string")
  );
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { baseVersion?: unknown }).baseVersion !== "number" ||
    !isSyncedState((body as { state?: unknown }).state)
  ) {
    return Response.json(
      { error: "Expected { baseVersion: number, state: { sessions, seenFollowUpCallIds, phoneCalls, phoneCallsFetchedAt, feedbackItems } }" },
      { status: 400 }
    );
  }

  const { baseVersion, state } = body as { baseVersion: number; state: SyncedState };
  const result = await writeSyncState(baseVersion, state);

  if (!result.ok) {
    return Response.json(
      { error: "Version conflict", version: result.current?.version ?? 0, updatedAt: result.current?.updatedAt ?? null, state: result.current?.state ?? null },
      { status: 409 }
    );
  }

  broadcast({ version: result.version, buildId: BUILD_ID });
  return Response.json({ version: result.version, updatedAt: result.updatedAt });
}
