import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

export const runtime = "nodejs";

// Reads straight from disk on every request rather than importing at build
// time — this is what makes the About panel always show whatever version
// is actually running on this server, with no separate sync step needed
// between deploying new code and the panel reflecting it.
export async function GET() {
  try {
    const root = process.cwd();
    const [pkgRaw, changelog] = await Promise.all([
      readFile(path.join(root, "package.json"), "utf-8"),
      readFile(path.join(root, "CHANGELOG.md"), "utf-8"),
    ]);
    const version = JSON.parse(pkgRaw).version ?? "unknown";
    return NextResponse.json({ version, changelog });
  } catch {
    return NextResponse.json({ error: "Unable to read version/changelog" }, { status: 500 });
  }
}
