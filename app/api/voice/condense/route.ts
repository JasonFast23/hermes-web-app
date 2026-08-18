import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const CONDENSE_SYSTEM_PROMPT =
  "You compress AI assistant replies into a short spoken summary for a " +
  "voice interface. Reply with ONLY the summary — a few natural spoken " +
  "sentences (2-3 sentences), not the full original. Plain spoken text " +
  "only: no quotes, no preamble like 'Summary:', no lists, and no " +
  "markdown or emphasis markers of any kind (no **, no _underscores_, " +
  "no #headings) — even if the original text used them. This gets read " +
  "aloud by a text-to-speech voice that audibly emphasizes anything " +
  "wrapped in asterisks, so carrying that formatting over would change " +
  "how it actually sounds, not just how it looks. Cover the key " +
  "result(s) conversationally; skip restating the question, skip minor " +
  "detail, and offer to send the full version via text or email if " +
  "there's meaningfully more to it.";

export async function POST(req: NextRequest) {
  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = body?.text;
  if (!text || typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "Missing text" }, { status: 400 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing GROQ_API_KEY" },
      { status: 500 }
    );
  }

  let groqRes: Response;
  try {
    groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        temperature: 0.3,
        stream: true,
        messages: [
          { role: "system", content: CONDENSE_SYSTEM_PROMPT },
          { role: "user", content: text.trim() },
        ],
      }),
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to reach Groq's API" },
      { status: 502 }
    );
  }

  if (!groqRes.ok || !groqRes.body) {
    const detail = await groqRes.text().catch(() => "");
    console.error(
      `Groq condense request failed: status=${groqRes.status} body=${detail}`
    );
    return NextResponse.json(
      { error: "Condense request failed", detail },
      { status: groqRes.status || 502 }
    );
  }

  return new Response(groqRes.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
