import { NextRequest } from "next/server";
import { addClient, removeClient } from "@/lib/sync-broadcast";
import { readSyncState } from "@/lib/sync-store";

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
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ version: current?.version ?? 0 })}\n\n`));
      } catch {
        // Best-effort — the client still gets the same version from its own
        // GET /api/sync, so a failure here just skips the early nudge.
      }
      // Periodic comment ping — keeps intermediary proxies/timeouts from
      // silently dropping an idle connection.
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
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
