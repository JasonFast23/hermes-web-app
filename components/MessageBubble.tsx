"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChatMessage, ToolEvent, friendlyToolLabel, useChatStore } from "@/lib/store";
import { FileIcon } from "./Icons";

// A steady, constant reveal pace — deliberately no "catch up faster when a
// backlog builds up" behavior. The model can generate a long research
// answer far faster than anyone reads it (measured ~150 tokens/sec against
// the real backend), so a catch-up burst just means the animation looks
// like it stalls, then dumps a paragraph at once — which is exactly the
// "did it just freeze" feeling this is meant to avoid. Revealing at one
// unwavering rate instead means a long answer takes a bit longer to
// finish appearing on screen than the network took to deliver it, which
// is the intended trade — that's what makes it read as being written in
// front of you instead of pasted in.
const REVEAL_INTERVAL_MS = 16;
const REVEAL_CHARS_PER_TICK = 3;

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

// Wraps every occurrence of any word from a Chats-search query in a <mark>
// that starts lit and fades to transparent. Matches per-keyword, same as
// the search itself (SessionListView) — a query can match a session with
// its words spread across different messages, so highlighting only the
// literal full phrase here could land on the right message and still show
// no highlight at all if that exact phrase never appears verbatim.
// Applied at the innermost text-node level (inside linkify/renderInline,
// below), never to raw unparsed content — splitting raw text on the query
// ahead of bold/link parsing would cut a "**bold**" pair in half whenever a
// match fell inside it, leaving literal asterisks with no partner to
// complete the pair.
function highlightText(text: string, query: string | undefined, glow: boolean, keyPrefix: string): ReactNode[] {
  if (!query) return [text];
  const keywords = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (keywords.length === 0) return [text];
  const parts = text.split(new RegExp(`(${keywords.join("|")})`, "ig"));
  const nodes: ReactNode[] = [];

  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      nodes.push(
        <mark
          key={`${keyPrefix}-m-${i}`}
          className={`rounded-sm text-zinc-900 transition-colors duration-[1000ms] ${
            glow ? "bg-amber-300/80" : "bg-transparent"
          }`}
        >
          {part}
        </mark>
      );
    } else {
      nodes.push(part);
    }
  });

  return nodes;
}

// Turns plain-text URLs (e.g. citations from the Research agent) into real
// clickable links, so a source next to a claim is actually verifiable
// instead of inert text. Trims sentence-trailing punctuation off the end
// of a match so "...(https://example.com)." doesn't link-swallow the ").".
// highlightQuery/glow, when present, mark matches within the plain-text
// segments (not inside the link text itself — a query landing inside a URL
// is rare enough not to bother with).
function linkify(text: string, keyPrefix: string, highlightQuery?: string, glow?: boolean): ReactNode[] {
  const parts = text.split(URL_PATTERN);
  const matches = text.match(URL_PATTERN) ?? [];

  const nodes: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (part) nodes.push(...highlightText(part, highlightQuery, !!glow, `${keyPrefix}-t${i}`));
    const rawUrl = matches[i];
    if (!rawUrl) return;

    const trailingMatch = rawUrl.match(TRAILING_PUNCTUATION);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const url = trailing ? rawUrl.slice(0, rawUrl.length - trailing.length) : rawUrl;

    nodes.push(
      <a
        key={`${keyPrefix}-link-${i}`}
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

const BOLD_PATTERN = /\*\*([^\n*]+?)\*\*/g;

// Agents are asked to lead with a short, bolded direct answer (see the
// Research agent's system prompt) — render that markdown as actual bold
// instead of leaving literal asterisks in the bubble. Runs linkify() on the
// plain segments around each bolded span; a URL landing inside ** ** is
// rare enough not to bother matching too. Splits on BOLD_PATTERN first, so
// a "**bold**" pair is always resolved as a whole before highlightQuery
// ever gets a chance to split into its interior — search-matched text
// inside a bold span still renders bold, with a nested highlight.
function renderInline(text: string, keyPrefix: string, highlightQuery?: string, glow?: boolean): ReactNode[] {
  const segments = text.split(BOLD_PATTERN);
  const nodes: ReactNode[] = [];

  segments.forEach((segment, i) => {
    if (!segment) return;
    if (i % 2 === 1) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${i}`}>{highlightText(segment, highlightQuery, !!glow, `${keyPrefix}-b${i}`)}</strong>
      );
    } else {
      nodes.push(...linkify(segment, `${keyPrefix}-${i}`, highlightQuery, glow));
    }
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

// Research can take a real screenshot of a source page (its browser tool's
// vision/screenshot command) to back up a figure the user would otherwise
// have to click through and verify themselves — see its system prompt. The
// Hermes backend (gateway/platforms/api_server.py's _resolve_media_to_data_urls)
// already rewrites the model's own "MEDIA:<path>" tag into standard Markdown
// image syntax with the image inlined as a base64 data URL before it ever
// reaches us, specifically because a remote API client like this app can't
// read a local file path on the server — so this only ever needs to render
// an already-self-contained data: URL, never fetch anything itself.
const IMAGE_MARKDOWN_PATTERN = /!\[([^\]]*)\]\((data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+)\)/g;

function ScreenshotImage({ alt, src }: { alt: string; src: string }) {
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="my-1.5 block overflow-hidden rounded-xl border border-black/[0.08] bg-white"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt || "Screenshot"} className="max-h-80 w-full bg-zinc-50 object-contain" />
    </a>
  );
}

// Splits on SHOWFILE markers, rendering the rest of each text segment
// through renderInline() (bold + links) as before.
function renderShowfileSegment(text: string, highlightQuery?: string, glow?: boolean, keyPrefix = "seg"): ReactNode[] {
  const parts = text.split(SHOWFILE_PATTERN);
  const nodes: ReactNode[] = [];

  for (let i = 0; i < parts.length; i += 3) {
    const textPart = parts[i];
    if (textPart) nodes.push(...renderInline(textPart, `${keyPrefix}-${i}`, highlightQuery, glow));

    const fileId = parts[i + 1];
    const filename = parts[i + 2];
    if (fileId && filename) {
      nodes.push(<FileCard key={`file-${fileId}-${keyPrefix}-${i}`} fileId={fileId} filename={filename.trim()} />);
    }
  }

  return nodes;
}

// Splits on inline screenshot images first (rendered as image cards),
// running the rest of each text segment through renderShowfileSegment().
function renderContent(text: string, highlightQuery?: string, glow?: boolean): ReactNode[] {
  const parts = text.split(IMAGE_MARKDOWN_PATTERN);
  const nodes: ReactNode[] = [];

  for (let i = 0; i < parts.length; i += 3) {
    const textPart = parts[i];
    if (textPart) nodes.push(...renderShowfileSegment(textPart, highlightQuery, glow, `img-${i}`));

    const alt = parts[i + 1];
    const dataUrl = parts[i + 2];
    if (dataUrl) {
      nodes.push(<ScreenshotImage key={`shot-${i}`} alt={alt} src={dataUrl} />);
    }
  }

  return nodes;
}

// How long the search-match highlight stays lit before fading, and how
// long the fade-out transition itself takes (must match the <mark>'s own
// `duration-[1000ms]` below).
const SEARCH_GLOW_MS = 2200;
const FADE_MS = 1000;

export function MessageBubble({
  message,
  highlightQuery,
}: {
  message: ChatMessage;
  highlightQuery?: string;
}) {
  const isUser = message.role === "user";

  // Seeded lit whenever this instance mounts with a highlightQuery already
  // set — ChatPanel keys the bubble on highlight state, so a message that
  // *starts* being the search target remounts fresh here rather than this
  // effect reaching back to flip glow on (which would be a same-render
  // setState-in-effect anti-pattern). The effect's only job is the fade
  // timer, a genuine "after mount" side effect.
  const [glow, setGlow] = useState(() => !!highlightQuery);
  const clearScrollTarget = useChatStore((s) => s.clearScrollTarget);

  // This local timer is the single source of truth for how long a search
  // highlight lasts — ChatPanel used to own a separate timer for this and
  // it raced awkwardly with React re-renders, sometimes clearing the store
  // target (and thus the highlight) well before it should have. Clearing
  // scrollToMessage here, once the fade genuinely completes, is safe even
  // if a newer highlight has since taken over: that transition already
  // remounted this instance with a fresh key, so a stale timer from an old
  // instance can't be the one firing this late.
  //
  // Two separate timers, not one: clearing scrollToMessage changes
  // highlightQuery to undefined, which changes this component's key in
  // ChatPanel and remounts it. Firing that at the same instant as
  // setGlow(false) — as a single timer used to do — remounted the
  // component before the CSS fade transition ever got a chance to play,
  // so the highlight just vanished instead of fading. Waiting the fade's
  // own duration past that point lets the animation actually run first.
  // Mount-only (glow only ever goes true -> false once per instance, per
  // the comment above, so there's nothing to react to on later renders).
  useEffect(() => {
    if (!glow) return;
    const fadeStart = setTimeout(() => setGlow(false), SEARCH_GLOW_MS);
    const clear = setTimeout(() => clearScrollTarget(), SEARCH_GLOW_MS + FADE_MS);
    return () => {
      clearTimeout(fadeStart);
      clearTimeout(clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        return Math.min(target, len + REVEAL_CHARS_PER_TICK);
      });
    }, REVEAL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [message.content, isUser]);

  const visibleContent = isUser ? message.content : message.content.slice(0, displayLength);
  // Several distinct tool calls (e.g. a few Google API requests in a row)
  // often collapse to the same friendly label — show that phrase once
  // rather than repeating it, keeping the latest call's status/id so a
  // still-running group keeps pulsing.
  const toolEvents = (message.toolEvents ?? []).reduce<(ToolEvent & { label: string })[]>((acc, event) => {
    const label = friendlyToolLabel(event);
    const prev = acc[acc.length - 1];
    if (prev && prev.label === label) {
      acc[acc.length - 1] = { ...event, label };
    } else {
      acc.push({ ...event, label });
    }
    return acc;
  }, []);
  // A running tool's own row already pulses (see below), so the dots would
  // be a redundant second animation stacked on top of it. But the moment
  // nothing is actively running — before the first tool call, in the gap
  // between two calls, or after the last one while the model writes its
  // final answer — every row goes still and nothing on screen moves at
  // all, which is exactly what reads as "frozen." Keep the dots up for
  // all of those gaps, not just the very first one.
  const hasRunningTool = toolEvents.some((e) => e.status === "running");

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[75%] min-w-0 whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
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
                <span className="truncate">{event.label}</span>
              </div>
            ))}
          </div>
        )}

        {visibleContent
          ? renderContent(visibleContent, highlightQuery, glow)
          : !hasRunningTool && (
              <span className="inline-flex items-center gap-1 py-1" aria-label="Thinking">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
              </span>
            )}
      </div>
    </div>
  );
}
