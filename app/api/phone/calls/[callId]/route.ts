import { NextRequest, NextResponse } from "next/server";
import { invalidatePhoneCallsCache } from "../route";

export const runtime = "nodejs";

// Full detail for one call — transcript and recording included — fetched
// only when someone actually opens a call from the list (see the sibling
// route), since Retell's list endpoint omits both to keep listing many
// calls fast.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ callId: string }> }
) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server is missing RETELL_API_KEY" }, { status: 500 });
  }

  const { callId } = await params;
  if (!/^[a-zA-Z0-9_-]+$/.test(callId)) {
    return NextResponse.json({ error: "Invalid call id" }, { status: 400 });
  }

  let retellRes: Response;
  try {
    retellRes = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return NextResponse.json({ error: "Unable to reach Retell API" }, { status: 502 });
  }

  const data = await retellRes.json().catch(() => null);
  if (!retellRes.ok || !data) {
    return NextResponse.json(
      { error: "Retell get-call failed", detail: data },
      { status: retellRes.status || 502 }
    );
  }

  return NextResponse.json(data);
}

// Permanently deletes the call and its transcript/recording from Retell —
// not a local hide, there's no undo. See
// https://api.retellai.com/v2/delete-call/{callId}.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ callId: string }> }
) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server is missing RETELL_API_KEY" }, { status: 500 });
  }

  const { callId } = await params;
  if (!/^[a-zA-Z0-9_-]+$/.test(callId)) {
    return NextResponse.json({ error: "Invalid call id" }, { status: 400 });
  }

  let retellRes: Response;
  try {
    retellRes = await fetch(`https://api.retellai.com/v2/delete-call/${callId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return NextResponse.json({ error: "Unable to reach Retell API" }, { status: 502 });
  }

  if (!retellRes.ok) {
    const detail = await retellRes.text().catch(() => "");
    return NextResponse.json(
      { error: "Retell delete-call failed", detail },
      { status: retellRes.status || 502 }
    );
  }

  invalidatePhoneCallsCache();
  return NextResponse.json({ ok: true });
}
