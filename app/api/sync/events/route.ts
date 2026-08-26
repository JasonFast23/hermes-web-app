import { NextRequest } from "next/server";
import { addClient, removeClient } from "@/lib/sync-broadcast";
import { readSyncState } from "@/lib/sync-store";
import { BUILD_ID } from "@/lib/build-id";

export const runtime = "nodejs";

const encoder = new TextEncoder();

export async function GET(req: NextRequest) {
  let keepAlive: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    async start(controller) {
      addClient(controller);
      // Pushes the current version immediately on connect — closes the
      // small gap between a client's initial GET /api/sync and this
      // EventSource attaching, during which a version bump would otherwise
      // go unnoticed until the next change.
      try {
        const current = await readSyncState();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ version: current?.version ?? 0, buildId: BUILD_ID })}\n\n`));
      } catch {
        // Best-effort — the client still gets the same version from its own
        // GET /api/sync, so a failure here just skips the early nudge.
      }
      // Periodic message — doubles as the keepalive (any traffic keeps
      // intermediary proxies/timeouts from dropping an idle connection)
      // and as a standing staleness check: a client that's been open for
      // hours (a long-lived Electron window, a browser tab never closed)
      // gets its buildId re-checked every 30s even if nothing has actually
      // synced in that time, not just on connect — see
      // lib/syncClientStorage.ts's handling of this message.
      keepAlive = setInterval(async () => {
        try {
          const current = await readSyncState();
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ version: current?.version ?? 0, buildId: BUILD_ID })}\n\n`)
          );
        } catch {
          removeClient(controller);
        }
      }, 30000);
    },
    cancel(controller) {
      clearInterval(keepAlive);
      removeClient(controller as unknown as ReadableStreamDefaultController);
    },
  });

  req.signal.addEventListener("abort", () => {
    clearInterval(keepAlive);
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
