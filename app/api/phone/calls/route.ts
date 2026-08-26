import { NextResponse } from "next/server";

export const runtime = "nodejs";

// This route runs as one long-lived Node process (see server.js), so
// module-level state like this genuinely persists across requests — a
// simple in-memory cache, no external store needed. Kept short: long
// enough that the app's own bell/PhoneView instances (which already
// de-dupe concurrent calls client-side — see fetchPhoneCalls in
// lib/store.ts) don't each trigger a separate upstream hit on every
// reload, short enough that a call which just ended shows up on the next
// request rather than sitting stale for minutes.
const CACHE_TTL_MS = 15_000;
let cache: { calls: { call_type?: string }[]; expiresAt: number } | null = null;

// The real call history for Priscilla's Retell number — every inbound
// call she got and every outbound call Eva placed on her behalf. Only
// lightweight metadata (date, direction, duration, the AI-generated
// summary) comes back from this list — Retell's v3 list-calls endpoint
// deliberately omits the full transcript and recording per call to keep
// a list of many calls fast; a specific call's transcript is fetched on
// demand via /api/phone/calls/[callId] only once someone actually opens
// it, not upfront for the whole list.
export async function GET() {
  if (cache && cache.expiresAt > Date.now()) {
    return NextResponse.json({ calls: cache.calls });
  }

  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server is missing RETELL_API_KEY" }, { status: 500 });
  }

  let retellRes: Response;
  try {
    retellRes = await fetch("https://api.retellai.com/v3/list-calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sort_order: "descending", limit: 100 }),
    });
  } catch {
    return NextResponse.json({ error: "Unable to reach Retell API" }, { status: 502 });
  }

  const data = await retellRes.json().catch(() => null);
  if (!retellRes.ok || !data) {
    return NextResponse.json(
      { error: "Retell list-calls failed", detail: data },
      { status: retellRes.status || 502 }
    );
  }

  // Retell's actual v3 response wraps the list as { items: [...] } —
  // confirmed against the live API, not documented consistently. Still
  // defensive about a bare array or a "calls" key in case that ever
  // changes, rather than assuming just one shape.
  const allCalls: { call_type?: string }[] = Array.isArray(data)
    ? data
    : Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.calls)
        ? data.calls
        : [];

  // Excludes browser-mic simulated calls from the Test Tools panel —
  // those have no real phone number and aren't what Priscilla means by
  // "a call that happened." Real calls are call_type "phone_call"; the
  // simulator's are "web_call".
  const calls = allCalls.filter((c) => c.call_type === "phone_call");

  cache = { calls, expiresAt: Date.now() + CACHE_TTL_MS };
  return NextResponse.json({ calls });
}
