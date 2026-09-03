import { NextRequest, NextResponse } from "next/server";
import { PDFParse } from "pdf-parse";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import * as XLSX from "xlsx";

export const runtime = "nodejs";

// pdfjs-dist (which pdf-parse wraps) normally loads its parser off a real
// worker thread; outside a browser it falls back to dynamically
// import()-ing its own worker module and running it in-process. That
// dynamic import's specifier is only known at runtime, which Turbopack
// can't follow — it rewrites the path into somewhere the built output
// doesn't have the file, so the import throws. pdfjs checks
// globalThis.pdfjsWorker first and skips the dynamic import entirely if
// it's already there, so statically importing the worker module (a
// fixed specifier Turbopack CAN bundle) and stashing it there sidesteps
// the broken path guessing altogether. Must happen before any parsing.
(globalThis as { pdfjsWorker?: typeof pdfjsWorker }).pdfjsWorker = pdfjsWorker;

// Bounds how much of a file's text ever reaches an agent as context — see
// buildFileContext in lib/store.ts for why (unbounded text resent on every
// turn was already found, for a similar case, to degrade Eva's replies
// across the board). Generous relative to that other cap since a file the
// user deliberately attached is usually central to the conversation, not
// background noise.
const MAX_EXTRACT_CHARS = 20_000;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

type FileKind = "pdf" | "spreadsheet";

function kindFor(filename: string, mimeType: string): FileKind | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || mimeType === "application/pdf") return "pdf";
  if (["xlsx", "xls", "csv"].includes(ext)) return "spreadsheet";
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel" ||
    mimeType === "text/csv"
  ) {
    return "spreadsheet";
  }
  return null;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    // Default pageJoiner appends a "-- page N of M --" marker after every
    // page, which is meaningless noise for a model reading this as plain
    // context rather than a paginated document.
    const result = await parser.getText({ pageJoiner: "\n" });
    return result.text;
  } finally {
    await parser.destroy();
  }
}

// Every sheet rendered as CSV and concatenated under a header naming it —
// CSV (not JSON or the raw cell grid) because it's the most token-efficient
// text shape for a model to read numbers and headers out of, and it's what
// XLSX.utils already produces directly with no extra formatting work.
function extractSpreadsheet(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    return `Sheet: ${name}\n${csv}`;
  }).join("\n\n");
}

export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File is too large (15MB max)" }, { status: 413 });
  }

  const kind = kindFor(file.name, file.type);
  if (!kind) {
    return NextResponse.json(
      { error: "Unsupported file type — PDF, XLSX, XLS, or CSV only" },
      { status: 415 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let text: string;
  try {
    text = kind === "pdf" ? await extractPdf(buffer) : extractSpreadsheet(buffer);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Couldn't read that file: ${detail}` }, { status: 422 });
  }

  const trimmed = text.trim();
  const truncated = trimmed.length > MAX_EXTRACT_CHARS;

  return NextResponse.json({
    filename: file.name,
    kind,
    text: truncated ? trimmed.slice(0, MAX_EXTRACT_CHARS) : trimmed,
    truncated,
  });
}
