import { NextRequest } from "next/server";
import { addClient, removeClient, clientCount, broadcast } from "@/lib/notify-broadcast";

export const runtime = "nodejs";

const encoder = new TextEncoder();

export async function GET(req: NextRequest) {
  let keepAlive: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(controller) {
      addClient(controller);
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

interface NotifyPayload {
  title: string;
  body?: string;
  callId?: string;
}

function isNotifyPayload(value: unknown): value is NotifyPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as NotifyPayload).title === "string" &&
    ((value as NotifyPayload).body === undefined || typeof (value as NotifyPayload).body === "string") &&
    ((value as NotifyPayload).callId === undefined || typeof (value as NotifyPayload).callId === "string")
  );
}

// Lets anything on the tailnet push a toast into the app directly over
// HTTP — used by the phone bridge (a separate process, reached publicly by
// Retell's webhook) to relay a "note for Priscilla" notification once a
// call's post-call analysis is ready. Bearer-guarded since this is the one
// write path into the app's notification stream from outside its own
// process.
export async function POST(req: NextRequest) {
  const expectedKey = process.env.NOTIFY_API_KEY;
  if (!expectedKey) {
    return Response.json({ error: "NOTIFY_API_KEY not configured on server" }, { status: 500 });
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${expectedKey}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isNotifyPayload(body)) {
    return Response.json({ error: "Expected { title: string, body?: string, callId?: string }" }, { status: 400 });
  }

  broadcast(body);
  return Response.json({ delivered: clientCount() });
}
