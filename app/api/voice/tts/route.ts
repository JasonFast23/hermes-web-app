import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

interface TtsRequestBody {
  text: string;
  // The sentence spoken immediately before this one in the same turn, if
  // any. Each sentence is synthesized as its own independent request (so
  // TTS can start on the first one while Eva is still generating the
  // rest) — without this, ElevenLabs has no idea a given fragment is a
  // continuation of anything and predicts its prosody/energy from
  // scratch each time, which is what produces audible loud/quiet swings
  // between consecutive sentences. Passing it as `previous_text` is
  // ElevenLabs' documented mechanism for keeping chunked synthesis
  // consistent across calls.
  previousText?: string;
}

export async function POST(req: NextRequest) {
  let body: TtsRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = body?.text;
  if (!text || typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "Missing text" }, { status: 400 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    return NextResponse.json(
      { error: "Server is missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID" },
      { status: 500 }
    );
  }

  let elevenRes: Response;
  try {
    elevenRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: text.trim(),
        // Flash generates in ~75ms vs. Turbo's ~250-300ms — the model
        // ElevenLabs themselves recommend for real-time/conversational
        // use, at a small, accepted quality cost.
        model_id: "eleven_flash_v2_5",
        ...(body.previousText?.trim() ? { previous_text: body.previousText.trim() } : {}),
      }),
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to reach ElevenLabs' API" },
      { status: 502 }
    );
  }

  if (!elevenRes.ok || !elevenRes.body) {
    const detail = await elevenRes.text().catch(() => "");
    console.error(
      `ElevenLabs TTS request failed: status=${elevenRes.status} body=${detail}`
    );
    return NextResponse.json(
      { error: "Speech synthesis failed", detail },
      { status: elevenRes.status || 502 }
    );
  }

  return new Response(elevenRes.body, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
