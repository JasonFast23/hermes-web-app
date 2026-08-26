"use client";

import { useMemo, useState } from "react";
import { useChatStore } from "@/lib/store";
import { AgentId } from "@/lib/agents";
import { CheckIcon, MenuIcon, PlusIcon, SearchIcon, XIcon } from "./Icons";

const SNIPPET_RADIUS = 40;

// A multi-word search is treated as "every one of these words, anywhere" —
// not one literal phrase — matching how Slack/Gmail-style search boxes
// behave, and how everything below (containsAllKeywords, highlighting,
// snippets) operates on the query.
function tokenize(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function containsAllKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.every((k) => lower.includes(k));
}

// Earliest position any keyword actually occurs at, so a snippet spanning
// several words centers on something the user searched for rather than
// just the start of the message.
function firstKeywordIndex(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let best = -1;
  for (const k of keywords) {
    const idx = lower.indexOf(k);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

// Pulls a short window of text around the first keyword match, collapsed
// to one line, with ellipses where it was truncated — gives context
// without dumping the whole message into the row.
function buildSnippet(content: string, keywords: string[]): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const idx = firstKeywordIndex(flat, keywords);
  if (idx === -1) return flat.slice(0, SNIPPET_RADIUS * 2);

  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(flat.length, start + SNIPPET_RADIUS * 3);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  return prefix + flat.slice(start, end) + suffix;
}

// Splits text on every keyword (case-insensitive, alternated into one
// regex) and wraps each match in <mark> — relies on String.split's
// behavior of interleaving captured groups at odd indices, so no regex
// .lastIndex state to worry about.
function highlightMatches(text: string, keywords: string[]) {
  if (keywords.length === 0) return text;

  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "ig"));

  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-sm bg-amber-200/70 text-zinc-900">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60_000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;

  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

export function SessionListView() {
  const sessions = useChatStore((s) => s.sessions);
  const switchSession = useChatStore((s) => s.switchSession);
  const openSearchResult = useChatStore((s) => s.openSearchResult);
  const startNewSession = useChatStore((s) => s.startNewSession);
  const deleteSessions = useChatStore((s) => s.deleteSessions);
  const setMobileSidebarOpen = useChatStore((s) => s.setMobileSidebarOpen);

  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const keywords = useMemo(() => tokenize(query), [query]);

  const visibleSessions = useMemo(() => {
    const list = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
    if (keywords.length === 0) return list;
    return list.filter((s) => {
      // Every keyword has to be present SOMEWHERE in the session — title
      // or any message in any thread — but not necessarily all in the
      // same field or as one contiguous phrase. A query like "voice bug"
      // matches a session where "voice" is in one message and "bug" is in
      // another, same as it would in Slack/Gmail-style search.
      const combined = [
        s.title,
        ...Object.values(s.threads).flatMap((messages) => messages?.map((m) => m.content) ?? []),
      ].join(" \n ");
      return containsAllKeywords(combined, keywords);
    });
  }, [sessions, keywords]);

  // Finds the single message that best represents the match — the one
  // containing the most of the searched keywords — so the row's snippet
  // and the click-through destination point at actual matching content,
  // not just wherever the session happens to open by default. Always
  // computed, even when the title itself also matched: a title match
  // shouldn't hide a stronger, more specific hit sitting in the
  // conversation itself.
  const matchSnippets = useMemo(() => {
    const map = new Map<string, { agentId: AgentId; messageId: string; content: string }>();
    if (keywords.length === 0) return map;

    for (const session of visibleSessions) {
      let best: { agentId: AgentId; messageId: string; content: string; score: number } | null = null;
      for (const [agentId, messages] of Object.entries(session.threads) as [AgentId, typeof session.threads[AgentId]][]) {
        for (const m of messages ?? []) {
          const lower = m.content.toLowerCase();
          const score = keywords.filter((k) => lower.includes(k)).length;
          if (score > 0 && (!best || score > best.score)) {
            best = { agentId, messageId: m.id, content: m.content, score };
          }
        }
      }
      if (best) map.set(session.id, best);
    }
    return map;
  }, [visibleSessions, keywords]);

  const exitSelectMode = () => {
    setSelecting(false);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected = visibleSessions.length > 0 && visibleSessions.every((s) => selectedIds.has(s.id));

  const handleRowClick = (id: string) => {
    if (selecting) {
      toggleSelected(id);
      return;
    }
    // A content match (as opposed to a title-only match, or no active
    // search) jumps straight to the agent thread and message it came
    // from and briefly highlights it, instead of just opening the
    // session and leaving the user to hunt for the keyword themselves.
    const match = query.trim() ? matchSnippets.get(id) : undefined;
    if (match) {
      openSearchResult(id, match.agentId, match.messageId, query.trim());
    } else {
      switchSession(id);
    }
  };

  const handleDelete = () => {
    deleteSessions([...selectedIds]);
    exitSelectMode();
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#f4f6fb]">
      <div className="flex min-h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-black/[0.06] px-3 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] sm:px-6">
        {selecting ? (
          <>
            <button
              type="button"
              onClick={exitSelectMode}
              className="rounded-md px-2 py-1.5 text-[13px] font-medium text-zinc-600 hover:bg-black/[0.05]"
            >
              Cancel
            </button>
            <span className="text-[13px] text-zinc-500">{selectedIds.size} selected</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedIds(allVisibleSelected ? new Set() : new Set(visibleSessions.map((s) => s.id)))}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-zinc-700"
              >
                {allVisibleSelected ? "Deselect all" : "Select all"}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={selectedIds.size === 0}
                className="rounded-md bg-zinc-200 px-3 py-1.5 text-[13px] font-medium text-zinc-700 hover:bg-red-100 hover:text-red-600 disabled:pointer-events-none disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Open menu"
                onClick={() => setMobileSidebarOpen(true)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-black/[0.04] md:hidden"
              >
                <MenuIcon className="h-5 w-5" />
              </button>
              <h1 className="text-xl font-semibold text-zinc-800">Chats</h1>
            </div>
            <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelecting(true)}
              className="rounded-md bg-zinc-200 px-3 py-1.5 text-[13px] font-medium text-zinc-700 hover:bg-zinc-300"
            >
              Select chats
            </button>
            <button
              type="button"
              onClick={startNewSession}
              className="flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-zinc-700"
            >
              <PlusIcon className="h-[15px] w-[15px]" />
              New session
            </button>
            </div>
          </>
        )}
      </div>

      <div className="shrink-0 px-3 pt-4 sm:px-6">
        <div className="flex items-center gap-2.5 rounded-full border border-black/[0.07] bg-white px-4 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] focus-within:border-black/[0.15]">
          <SearchIcon className="h-[18px] w-[18px] shrink-0 text-zinc-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="w-full bg-transparent text-sm text-zinc-700 outline-none placeholder:text-zinc-400"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-black/[0.06] hover:text-zinc-600"
            >
              <XIcon className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {visibleSessions.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-zinc-400">
            {query ? "No chats match your search." : "No chats yet."}
          </p>
        ) : (
          visibleSessions.map((sess) => {
            const isSelected = selectedIds.has(sess.id);
            const matchedContent = matchSnippets.get(sess.id);
            return (
              <button
                key={sess.id}
                type="button"
                onClick={() => handleRowClick(sess.id)}
                className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-black/[0.03]"
              >
                {selecting && (
                  <span
                    className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border transition-colors ${
                      isSelected ? "border-zinc-900 bg-zinc-900" : "border-zinc-300 bg-white"
                    }`}
                  >
                    {isSelected && <CheckIcon className="h-3 w-3 text-white" />}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] text-zinc-800">
                    {keywords.length > 0 ? highlightMatches(sess.title, keywords) : sess.title}
                  </span>
                  {keywords.length > 0 && matchedContent && (
                    <span className="mt-0.5 block truncate text-[12.5px] text-zinc-500">
                      {highlightMatches(buildSnippet(matchedContent.content, keywords), keywords)}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[12.5px] text-zinc-400">{formatRelativeTime(sess.createdAt)}</span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
