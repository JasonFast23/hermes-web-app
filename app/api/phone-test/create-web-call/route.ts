import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Browser-mic test call against the Retell agent (see hermes-phone-bridge),
// with no phone number involved — exercises the exact same custom-LLM
// websocket path a real phone call would.
export async function POST() {
  const apiKey = process.env.RETELL_API_KEY;
  const agentId = process.env.RETELL_AGENT_ID;

  if (!apiKey || !agentId) {
    return NextResponse.json(
      { error: "Server is missing RETELL_API_KEY/RETELL_AGENT_ID" },
      { status: 500 }
    );
  }

  let retellRes: Response;
  try {
    retellRes = await fetch("https://api.retellai.com/v2/create-web-call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agent_id: agentId }),
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to reach Retell API" },
      { status: 502 }
    );
  }

  const data = await retellRes.json().catch(() => null);
  if (!retellRes.ok || !data) {
    return NextResponse.json(
      { error: "Retell create-web-call failed", detail: data },
      { status: retellRes.status || 502 }
    );
  }

  return NextResponse.json({ accessToken: data.access_token, callId: data.call_id });
}
