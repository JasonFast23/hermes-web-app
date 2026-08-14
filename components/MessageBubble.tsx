"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChatMessage } from "@/lib/store";
import { FileIcon } from "./Icons";

const REVEAL_INTERVAL_MS = 12;
const REVEAL_CHARS_PER_TICK = 2;
// If a big chunk lands at once (e.g. a delegated report-back posted as one
// finished block instead of streamed token-by-token), catch up faster than
// the default per-tick rate so it doesn't take forever to unwrap.
const CATCH_UP_THRESHOLD = 60;

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

// Turns plain-text URLs (e.g. citations from the Research agent) into real
// clickable links, so a source next to a claim is actually verifiable
// instead of inert text. Trims sentence-trailing punctuation off the end
// of a match so "...(https://example.com)." doesn't link-swallow the ").".
function linkify(text: string): ReactNode[] {
  const parts = text.split(URL_PATTERN);
  const matches = text.match(URL_PATTERN) ?? [];

  const nodes: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (part) nodes.push(part);
    const rawUrl = matches[i];
    if (!rawUrl) return;

    const trailingMatch = rawUrl.match(TRAILING_PUNCTUATION);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const url = trailing ? rawUrl.slice(0, rawUrl.length - trailing.length) : rawUrl;

    nodes.push(
      <a
        key={i}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:opacity-80"
      >
        {url}
      </a>
    );
    if (trailing) nodes.push(trailing);
  });

  return nodes;
}

// Emitted by the Case File agent (e.g. "[[SHOWFILE:7984|Complaint.pdf]]")
// when the user asked to actually see a document, not just be told about
// it. Rendered as an inline preview/download card instead of literal
// marker text — served through our own proxy route so the case file
// backend's key never reaches the browser.
const SHOWFILE_PATTERN = /\[\[SHOWFILE:(\d+)\|([^\]\n]+)\]\]/g;
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp)$/i;

function FileCard({ fileId, filename }: { fileId: string; filename: string }) {
  const src = `/api/casefile/files/${fileId}`;
  const isImage = IMAGE_EXT_PATTERN.test(filename);

  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-black/[0.08] bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] bg-black/[0.02] px-3 py-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <FileIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          <span className="truncate text-[12px] font-medium text-zinc-700">{filename}</span>
        </span>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[11px] text-zinc-500 underline underline-offset-2 hover:text-zinc-800"
        >
          Open ↗
        </a>
      </div>
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={filename} className="max-h-80 w-full bg-zinc-50 object-contain" />
      ) : (
        <iframe src={src} title={filename} className="h-80 w-full" />
      )}
    </div>
  );
}

// Splits on SHOWFILE markers first (rendered as file cards), running the
// rest of each text segment through linkify() as before.
function renderContent(text: string): ReactNode[] {
  const parts = text.split(SHOWFILE_PATTERN);
  const nodes: ReactNode[] = [];

  for (let i = 0; i < parts.length; i += 3) {
    const textPart = parts[i];
    if (textPart) nodes.push(...linkify(textPart));

    const fileId = parts[i + 1];
    const filename = parts[i + 2];
    if (fileId && filename) {
      nodes.push(<FileCard key={`file-${fileId}-${i}`} fileId={fileId} filename={filename.trim()} />);
    }
  }

  return nodes;
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  // Assistant text reveals a couple characters at a time regardless of how
  // chunky the underlying network stream is. Seeded to the full length on
  // mount so historical messages (loaded from a session) show instantly
  // instead of re-animating every time you switch back to them.
  const [displayLength, setDisplayLength] = useState(() => message.content.length);

  useEffect(() => {
    if (isUser) return;
    const target = message.content.length;

    const id = setInterval(() => {
      setDisplayLength((len) => {
        if (len >= target) {
          clearInterval(id);
          return len;
        }
        const remaining = target - len;
        const step = remaining > CATCH_UP_THRESHOLD ? Math.ceil(remaining / 20) : REVEAL_CHARS_PER_TICK;
        return Math.min(target, len + step);
      });
    }, REVEAL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [message.content, isUser]);

  const visibleContent = isUser ? message.content : message.content.slice(0, displayLength);
  const toolEvents = message.toolEvents ?? [];

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[75%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "bg-zinc-900 text-white"
            : "bg-white text-zinc-800 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
        }`}
      >
        {toolEvents.length > 0 && (
          <div className="mb-2 flex flex-col gap-1 border-b border-black/[0.06] pb-2">
            {toolEvents.map((event) => (
              <div
                key={event.id}
                className={`flex items-center gap-1.5 text-[11.5px] ${
                  event.status === "running" ? "text-zinc-500" : "text-zinc-400"
                }`}
              >
                <span className={event.status === "running" ? "animate-pulse" : ""}>
                  {event.emoji ?? "⚙️"}
                </span>
                <span className="truncate">{event.label ?? event.tool}</span>
              </div>
            ))}
          </div>
        )}

        {visibleContent
          ? renderContent(visibleContent)
          : toolEvents.length === 0 && (
              <span className="inline-block animate-pulse text-zinc-400">▍</span>
            )}
      </div>
    </div>
  );
}
