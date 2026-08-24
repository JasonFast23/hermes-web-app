// Backs both handlers in app/api/notify/route.ts — GET registers a
// connected SSE client, POST broadcasts to all of them. This app itself is
// tailnet-only (see AGENTS.md/CLAUDE.md deployment notes), so an external
// caller like Retell's webhook can't reach it directly — that's handled by
// the phone bridge (a separate process, already publicly reachable via its
// own Tailscale Funnel for Retell's LLM websocket), which relays a note by
// calling POST /api/notify over the tailnet instead of importing this
// module directly.
//
// In-memory pub/sub for a single self-hosted Node process (this app runs as
// one `next start` process on a Tailscale-only host, never serverless/
// multi-instance) — a connected SSE client is just a controller we push
// encoded chunks into directly.
const clients = new Set<ReadableStreamDefaultController>();

const encoder = new TextEncoder();

export function addClient(controller: ReadableStreamDefaultController) {
  clients.add(controller);
}

export function removeClient(controller: ReadableStreamDefaultController) {
  clients.delete(controller);
}

export function clientCount(): number {
  return clients.size;
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
