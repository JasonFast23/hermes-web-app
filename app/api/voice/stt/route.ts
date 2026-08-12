import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const audio = formData.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ error: "Missing audio" }, { status: 400 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing GROQ_API_KEY" },
      { status: 500 }
    );
  }

  const filename = audio instanceof File ? audio.name : "recording.webm";
  const groqForm = new FormData();
  groqForm.append("file", audio, filename);
  groqForm.append("model", "whisper-large-v3-turbo");

  let groqRes: Response;
  try {
    groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: groqForm,
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to reach Groq's API" },
      { status: 502 }
    );
  }

  if (!groqRes.ok) {
    const detail = await groqRes.text().catch(() => "");
    console.error(
      `Groq transcription request failed: status=${groqRes.status} body=${detail}`
    );
    return NextResponse.json(
      { error: "Transcription request failed", detail },
      { status: groqRes.status || 502 }
    );
  }

  const data = await groqRes.json();
  return NextResponse.json({ text: typeof data.text === "string" ? data.text : "" });
}
