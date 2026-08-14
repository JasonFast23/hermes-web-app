import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const { fileId } = await params;

  if (!/^\d+$/.test(fileId)) {
    return NextResponse.json({ error: "Invalid file id" }, { status: 400 });
  }

  const baseUrl = process.env.HERMES_CASEFILE_FILES_API_URL;
  const apiKey = process.env.HERMES_CASEFILE_FILES_API_KEY;
  if (!baseUrl || !apiKey) {
    return NextResponse.json(
      { error: "Server is missing case file backend URL/key" },
      { status: 500 }
    );
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${baseUrl}/api/files/${fileId}/view`, {
      headers: { "x-bot-key": apiKey },
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to reach case file backend" },
      { status: 502 }
    );
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    const detail = await upstreamRes.text().catch(() => "");
    return NextResponse.json(
      { error: "Case file backend request failed", detail },
      { status: upstreamRes.status || 502 }
    );
  }

  const contentType = upstreamRes.headers.get("content-type") || "application/octet-stream";

  return new Response(upstreamRes.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=300",
    },
  });
}
