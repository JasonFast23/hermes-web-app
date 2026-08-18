import { NextRequest, NextResponse } from "next/server";
import { AGENTS, isAgentId } from "@/lib/agents";
import { getAgentBackend } from "@/lib/agent-backends";

export const runtime = "nodejs";

interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  messages: ChatHistoryMessage[];
  agentId: string;
  sessionKey: string;
  // Stable per (chat session, agent) id. Sent as X-Hermes-Session-Id so the
  // Hermes backend loads and persists the real conversation — including
  // tool calls/results — server-side via its own state.db, instead of us
  // resending the full text history (which never included tool activity
  // anyway) on every turn.
  hermesSessionId: string;
  // Optional extra system-role context (e.g. Eva's cross-agent activity
  // digest) inserted after the agent's own system prompt. Invisible to the
  // conversation history shown in any tab — purely shapes this one reply.
  context?: string;
  // Optional narrowing of the agent's configured toolsets for this one
  // request (e.g. Research's Fast mode dropping "browser"). Only ever
  // narrows — anything not already in the agent's own toolsets is ignored,
  // so a client can't use this to grant a tool the agent isn't configured
  // for.
  toolsetsOverride?: unknown;
}

function isChatHistory(value: unknown): value is ChatHistoryMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as ChatHistoryMessage).role !== undefined &&
        ((m as ChatHistoryMessage).role === "user" ||
          (m as ChatHistoryMessage).role === "assistant") &&
        typeof (m as ChatHistoryMessage).content === "string"
    )
  );
}

export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { messages: history, agentId, sessionKey, hermesSessionId, context, toolsetsOverride } = body;

  if (!isChatHistory(history)) {
    return NextResponse.json({ error: "Missing messages" }, { status: 400 });
  }
  if (!agentId || !isAgentId(agentId)) {
    return NextResponse.json({ error: "Unknown agentId" }, { status: 400 });
  }
  if (!sessionKey || typeof sessionKey !== "string") {
    return NextResponse.json({ error: "Missing sessionKey" }, { status: 400 });
  }
  if (!hermesSessionId || typeof hermesSessionId !== "string") {
    return NextResponse.json({ error: "Missing hermesSessionId" }, { status: 400 });
  }

  const agent = AGENTS[agentId];
  const backend = getAgentBackend(agentId);

  if (!backend) {
    return NextResponse.json(
      { error: `Server is missing API URL/key for agent "${agentId}"` },
      { status: 500 }
    );
  }

  const systemMessages = [
    ...(agent.systemPrompt ? [{ role: "system", content: agent.systemPrompt }] : []),
    ...(typeof context === "string" && context.trim() ? [{ role: "system", content: context }] : []),
  ];
  const messages = [...systemMessages, ...history];

  const narrowedToolsets =
    Array.isArray(toolsetsOverride) &&
    toolsetsOverride.every((t): t is string => typeof t === "string" && agent.toolsets.includes(t))
      ? toolsetsOverride
      : agent.toolsets;

  let hermesRes: Response;
  try {
    hermesRes = await fetch(`${backend.apiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${backend.apiKey}`,
        "X-Hermes-Session-Key": sessionKey,
        "X-Hermes-Session-Id": hermesSessionId,
      },
      body: JSON.stringify({
        model: agent.model,
        toolsets: narrowedToolsets,
        stream: true,
        messages,
      }),
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to reach Hermes API server" },
      { status: 502 }
    );
  }

  if (!hermesRes.ok || !hermesRes.body) {
    const detail = await hermesRes.text().catch(() => "");
    console.error(
      `Hermes API request failed: agentId=${agentId} status=${hermesRes.status} body=${detail}`
    );
    return NextResponse.json(
      { error: "Hermes API request failed", detail },
      { status: hermesRes.status || 502 }
    );
  }

  return new Response(hermesRes.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}