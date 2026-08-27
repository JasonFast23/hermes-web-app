import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Mints a short-lived (15 min, single-use) token for ElevenLabs' Scribe v2
// Realtime speech-to-text WebSocket — see lib/realtimeDictation.ts, which is
// the only caller. The browser connects directly to ElevenLabs' WebSocket
// with this token; audio never passes through our own server, only this
// tiny token mint does, so the real ELEVENLABS_API_KEY never reaches the
// client.
export async function POST() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing ELEVENLABS_API_KEY" },
      { status: 500 }
    );
  }

  let elevenRes: Response;
  try {
    elevenRes = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to reach ElevenLabs' API" },
      { status: 502 }
    );
  }

  if (!elevenRes.ok) {
    const detail = await elevenRes.text().catch(() => "");
    console.error(
      `ElevenLabs realtime token request failed: status=${elevenRes.status} body=${detail}`
    );
    return NextResponse.json(
      { error: "Failed to mint realtime STT token", detail },
      { status: elevenRes.status || 502 }
    );
  }

  const data = await elevenRes.json();
  return NextResponse.json({ token: typeof data.token === "string" ? data.token : "" });
}
