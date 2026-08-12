"use client";

import { useMemo, useState } from "react";
import { useChatStore } from "@/lib/store";
import { CheckIcon, PlusIcon, SearchIcon, XIcon } from "./Icons";

const SNIPPET_RADIUS = 40;

// Pulls a short window of text around the first match, collapsed to one
// line, with ellipses where it was truncated — gives context without
// dumping the whole message into the row.
function buildSnippet(content: string, query: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const idx = flat.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return flat.slice(0, SNIPPET_RADIUS * 2);

  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(flat.length, idx + query.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  return prefix + flat.slice(start, end) + suffix;
}

// Splits text on the (case-insensitive) query and wraps each match in
// <mark> — relies on String.split's behavior of interleaving captured
// groups at odd indices, so no regex .lastIndex state to worry about.
function highlightMatches(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));

  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-sm bg-amber-200/70 px-0.5 text-zinc-900">
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
  const startNewSession = useChatStore((s) => s.startNewSession);
  const deleteSessions = useChatStore((s) => s.deleteSessions);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const visibleSessions = useMemo(() => {
    const list = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
    if (!query.trim()) return list;
    const q = query.trim().toLowerCase();
    return list.filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true;
      // Also match on message content across every agent thread in the
      // session, not just the title — so keywords from anywhere in the
      // conversation surface the chat, not only its (often-truncated) title.
      return Object.values(s.threads).some((messages) =>
        messages?.some((m) => m.content.toLowerCase().includes(q))
      );
    });
  }, [sessions, query]);

  // For sessions whose match came from message content rather than the
  // title, find the matching message so a highlighted snippet of it can
  // be shown under the title for context.
  const matchSnippets = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, string>();
    if (!q) return map;

    for (const session of visibleSessions) {
      if (session.title.toLowerCase().includes(q)) continue;
      for (const messages of Object.values(session.threads)) {
        const hit = messages?.find((m) => m.content.toLowerCase().includes(q));
        if (hit) {
          map.set(session.id, hit.content);
          break;
        }
      }
    }
    return map;
  }, [visibleSessions, query]);

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
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-black/[0.06] px-6">
        <h1 className="text-xl font-semibold text-zinc-800">Chats</h1>

        {selecting ? (
          <div className="flex items-center gap-3 text-[13px]">
            <span className="text-zinc-500">{selectedIds.size} selected</span>
            <button
              type="button"
              onClick={() => setSelectedIds(allVisibleSelected ? new Set() : new Set(visibleSessions.map((s) => s.id)))}
              className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-white hover:bg-zinc-700"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={selectedIds.size === 0}
              className="rounded-md bg-zinc-200 px-3 py-1.5 font-medium text-zinc-700 hover:bg-red-100 hover:text-red-600 disabled:pointer-events-none disabled:opacity-40"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={exitSelectMode}
              className="rounded-md px-3 py-1.5 font-medium text-zinc-600 hover:bg-black/[0.05]"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {searchOpen ? (
              <div className="flex items-center gap-1.5 rounded-md border border-black/10 bg-white px-2 py-1.5">
                <SearchIcon className="h-[15px] w-[15px] text-zinc-400" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search chats"
                  className="w-40 bg-transparent text-[13px] text-zinc-700 outline-none placeholder:text-zinc-400"
                />
                <button
                  type="button"
                  onClick={() => {
                    setSearchOpen(false);
                    setQuery("");
                  }}
                  className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-black/[0.05]"
                  aria-label="Close search"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                aria-label="Search chats"
                className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-black/[0.05]"
              >
                <SearchIcon className="h-[17px] w-[17px]" />
              </button>
            )}
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
        )}
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
                    {query ? highlightMatches(sess.title, query) : sess.title}
                  </span>
                  {query && matchedContent && (
                    <span className="mt-0.5 block truncate text-[12.5px] text-zinc-500">
                      {highlightMatches(buildSnippet(matchedContent, query), query)}
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
