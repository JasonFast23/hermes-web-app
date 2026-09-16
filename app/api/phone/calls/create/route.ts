import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Real outbound call — dials a number, live, over the telephone network.
// This is what runPhoneBatch (lib/store.ts) hits for every [[DELEGATE:
// phone]] call Eva places.

// Hard ceiling Retell force-ends the call at, no matter what happens on
// either end — the backstop of last resort, independent of whether Eva's
// own [[HANGUP]] marker or the phone bridge's IVR-loop circuit breaker
// (hermes-phone-bridge/server.js) are working. Retell's own default here
// is 3,600,000ms (1 hour) — exactly the runaway duration that produced a
// real ~$5-6 overcharge on a call stuck repeating an IVR menu forever
// (see CHANGELOG). A few minutes past this app's own PHONE_BATCH_CALL_
// TIMEOUT_MS (5 min, lib/store.ts) so a call that's actually gotten a real
// person on the line still has room to finish before Retell cuts it off.
const MAX_CALL_DURATION_MS = 6 * 60 * 1000;

// US numbers only (this whole feature is one Retell US number). Accepts
// whatever loose format the model or a person typed — a formatted
// "(555) 123-4567", dashes, a bare 10-digit string, or an already-E.164
// number — and normalizes to what Retell's API requires.
function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\+1\d{10}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.RETELL_API_KEY;
  const fromNumber = process.env.RETELL_PHONE_NUMBER;
  const bridgeUrl = process.env.PHONE_BRIDGE_URL;
  const bridgeSecret = process.env.PHONE_BRIDGE_SECRET;

  if (!apiKey || !fromNumber || !bridgeUrl || !bridgeSecret) {
    return NextResponse.json(
      {
        error:
          "Server is missing RETELL_API_KEY/RETELL_PHONE_NUMBER/PHONE_BRIDGE_URL/PHONE_BRIDGE_SECRET",
      },
      { status: 500 }
    );
  }

  let body: { number?: unknown; purpose?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawNumber = typeof body.number === "string" ? body.number : "";
  const purpose = typeof body.purpose === "string" ? body.purpose.trim() : "";
  const toNumber = toE164(rawNumber);

  if (!toNumber) {
    return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
  }
  if (!purpose) {
    return NextResponse.json({ error: "Missing purpose" }, { status: 400 });
  }

  let retellRes: Response;
  try {
    retellRes = await fetch("https://api.retellai.com/v2/create-phone-call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from_number: fromNumber,
        to_number: toNumber,
        agent_override: { agent: { max_call_duration_ms: MAX_CALL_DURATION_MS } },
      }),
    });
  } catch {
    return NextResponse.json({ error: "Unable to reach Retell API" }, { status: 502 });
  }

  const data = await retellRes.json().catch(() => null);
  if (!retellRes.ok || !data?.call_id) {
    return NextResponse.json(
      { error: "Retell create-phone-call failed", detail: data },
      { status: retellRes.status || 502 }
    );
  }

  // Same register-task mechanism the outbound web-call simulator already
  // uses (see /api/phone-test/create-outbound-web-call) — the bridge
  // looks this up by call_id the moment its websocket connects and opens
  // with a purposeful introduction instead of the generic greeting. A
  // real phone call starts dialing the instant create-phone-call above
  // succeeds, unlike the web-call simulator (which only connects once the
  // browser client explicitly starts it) — so there's a real, if narrow,
  // race between Retell's websocket connecting and this call landing.
  // Not solved here: Retell doesn't forward custom request-time metadata
  // to a Custom LLM websocket handler, so there's no way to hand the task
  // over any earlier than this. The bridge degrades gracefully if it
  // loses the race (falls back to its generic greeting instead of
  // erroring), so this is a quality issue, not a correctness one.
  try {
    const registerRes = await fetch(`${bridgeUrl}/register-task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-secret": bridgeSecret,
      },
      body: JSON.stringify({ callId: data.call_id, task: purpose }),
    });
    if (!registerRes.ok) {
      const detail = await registerRes.text().catch(() => "");
      return NextResponse.json(
        {
          error: "Call placed, but failed to register its purpose with the phone bridge",
          detail,
          callId: data.call_id,
        },
        { status: 502 }
      );
    }
  } catch {
    return NextResponse.json(
      {
        error: "Call placed, but unable to reach the phone bridge to register its purpose",
        callId: data.call_id,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({ callId: data.call_id, toNumber });
}
