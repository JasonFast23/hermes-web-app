import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const NARRATE_SYSTEM_PROMPT_START =
  "You describe, in 3 to 5 simple words, what an AI assistant is about " +
  "to do / is starting, based on a technical tool or skill name, so a " +
  "non-technical person understands at a glance. No jargon, no tool or " +
  "skill names verbatim, no quotes, no preamble. Present tense, natural " +
  "spoken phrasing — e.g. 'Checking your email', 'Searching the web', " +
  "'Looking into that', 'Reading your calendar'. If you can't tell what " +
  "it is, just say 'Working on that.'";

const NARRATE_SYSTEM_PROMPT_DONE =
  "You describe, in 2 to 4 simple words, that an AI assistant just " +
  "finished a step and got a result, based on a technical tool or skill " +
  "name, so a non-technical person understands at a glance. No jargon, " +
  "no tool or skill names verbatim, no quotes, no preamble. Natural " +
  "spoken phrasing, brief and matter-of-fact — e.g. 'Found it', 'Got " +
  "your emails', 'All set', 'Here's what turned up'. If you can't tell " +
  "what it is, just say 'Got it.'";

export async function POST(req: NextRequest) {
  let body: { tool?: string; label?: string; phase?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const tool = typeof body?.tool === "string" ? body.tool : "";
  const label = typeof body?.label === "string" ? body.label : "";
  const hint = [label, tool].filter(Boolean).join(" / ");
  if (!hint.trim()) {
    return NextResponse.json({ error: "Missing tool/label" }, { status: 400 });
  }

  const systemPrompt = body?.phase === "done" ? NARRATE_SYSTEM_PROMPT_DONE : NARRATE_SYSTEM_PROMPT_START;

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
        model: "llama-3.1-8b-instant",
        temperature: 0.4,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: hint },
        ],
      }),
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
      `Groq narrate request failed: status=${groqRes.status} body=${detail}`
    );
    return NextResponse.json(
      { error: "Narrate request failed", detail },
      { status: groqRes.status || 502 }
    );
  }

  const data = await groqRes.json();
  const phrase = data?.choices?.[0]?.message?.content;
  return NextResponse.json({
    phrase: typeof phrase === "string" ? phrase.trim() : "",
  });
}
