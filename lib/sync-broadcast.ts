// Backs both handlers in app/api/sync/events/route.ts — GET registers a
// connected SSE client, and app/api/sync/route.ts's PUT broadcasts a
// version bump to all of them once a write succeeds, so every other open
// device knows to re-fetch /api/sync. Kept separate from
// lib/notify-broadcast.ts (same shape, different module) rather than
// generalized into one: that channel is bearer-gated because it's reachable
// from a separate, publicly-exposed process, while this one is never
// reachable from anywhere but this app's own client JS — folding the two
// together would blur that distinction for no benefit at just 2 use sites.
//
// In-memory pub/sub for a single self-hosted Node process (this app runs
// as one `node server.js` process — the standalone build — on a
// Tailscale-only host, never serverless/multi-instance) — a connected SSE
// client is just a controller we push encoded chunks into directly.
const clients = new Set<ReadableStreamDefaultController>();

const encoder = new TextEncoder();

export function addClient(controller: ReadableStreamDefaultController) {
  clients.add(controller);
}

export function removeClient(controller: ReadableStreamDefaultController) {
  clients.delete(controller);
}

export function broadcast(payload: unknown) {
  const chunk = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  for (const controller of clients) {
    try {
      controller.enqueue(chunk);
    } catch {
      clients.delete(controller);
    }
  }
}
