import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Same browser-mic test call as create-web-call, but tags the call with a
// task before Retell's websocket ever connects to the bridge — the bridge
// looks up that task by call_id and has Eva open with an introduction and
// a goal instead of the generic inbound greeting. This is the human-
// triggered stand-in for "call someone and find out X": always started
// explicitly from this page, never autonomous.
export async function POST(req: NextRequest) {
  const apiKey = process.env.RETELL_API_KEY;
  const agentId = process.env.RETELL_AGENT_ID;
  const bridgeUrl = process.env.PHONE_BRIDGE_URL;
  const bridgeSecret = process.env.PHONE_BRIDGE_SECRET;

  if (!apiKey || !agentId || !bridgeUrl || !bridgeSecret) {
    return NextResponse.json(
      {
        error:
          "Server is missing RETELL_API_KEY/RETELL_AGENT_ID/PHONE_BRIDGE_URL/PHONE_BRIDGE_SECRET",
      },
      { status: 500 }
    );
  }

  let body: { task?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const task = typeof body.task === "string" ? body.task.trim() : "";
  if (!task) {
    return NextResponse.json({ error: "Missing task" }, { status: 400 });
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
    return NextResponse.json({ error: "Unable to reach Retell API" }, { status: 502 });
  }

  const data = await retellRes.json().catch(() => null);
  if (!retellRes.ok || !data) {
    return NextResponse.json(
      { error: "Retell create-web-call failed", detail: data },
      { status: retellRes.status || 502 }
    );
  }

  try {
    const registerRes = await fetch(`${bridgeUrl}/register-task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-secret": bridgeSecret,
      },
      body: JSON.stringify({ callId: data.call_id, task }),
    });
    if (!registerRes.ok) {
      const detail = await registerRes.text().catch(() => "");
      return NextResponse.json(
        { error: "Failed to register task with phone bridge", detail },
        { status: 502 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Unable to reach phone bridge to register task" },
      { status: 502 }
    );
  }

  return NextResponse.json({ accessToken: data.access_token, callId: data.call_id });
}
