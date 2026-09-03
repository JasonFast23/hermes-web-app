"use client";

import { FormEvent, useState } from "react";
import { useChatStore } from "@/lib/store";
import { CheckIcon, MenuIcon } from "./Icons";

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

// A place to post a concern/bug directly in the app instead of emailing it —
// syncs across devices (see lib/syncClientStorage.ts) so whoever posted it
// and whoever's fixing it both see the same list without either having to
// relay anything by hand.
export function FeedbackView() {
  const feedbackItems = useChatStore((s) => s.feedbackItems);
  const postFeedback = useChatStore((s) => s.postFeedback);
  const toggleFeedbackResolved = useChatStore((s) => s.toggleFeedbackResolved);
  const setMobileSidebarOpen = useChatStore((s) => s.setMobileSidebarOpen);

  const [text, setText] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    postFeedback(trimmed);
    setText("");
  };

  const open = feedbackItems.filter((f) => !f.resolved);
  const resolved = feedbackItems.filter((f) => f.resolved);

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#f4f6fb]">
      <div className="flex min-h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b border-black/[0.06] px-3 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] sm:px-6">
        <button
          type="button"
          aria-label="Open menu"
          onClick={() => setMobileSidebarOpen(true)}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-black/[0.04] md:hidden"
        >
          <MenuIcon className="h-5 w-5" />
        </button>
        <h1 className="text-xl font-semibold text-zinc-800">Feedback</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <div className="mx-auto w-full max-w-2xl">
          <form onSubmit={submit} className="rounded-2xl border border-black/[0.07] bg-white p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(e);
                }
              }}
              rows={3}
              placeholder="Describe a bug or something that felt off… (Shift+Enter for a new line)"
              className="w-full resize-none bg-transparent text-sm text-zinc-700 outline-none placeholder:text-zinc-400"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!text.trim()}
                className="rounded-full bg-zinc-900 px-4 py-1.5 text-[13px] font-medium text-white transition-opacity disabled:opacity-40"
              >
                Post
              </button>
            </div>
          </form>

          {feedbackItems.length === 0 ? (
            <p className="mt-8 text-center text-sm text-zinc-400">Nothing posted yet.</p>
          ) : (
            <>
              {open.length > 0 && (
                <div className="mt-6 flex flex-col gap-2">
                  {open.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-start gap-3 rounded-2xl border border-black/[0.07] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                    >
                      <button
                        type="button"
                        onClick={() => toggleFeedbackResolved(item.id)}
                        aria-label="Mark as fixed"
                        title="Mark as fixed"
                        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-black/[0.15] text-transparent hover:border-zinc-400 hover:text-zinc-400"
                      >
                        <CheckIcon className="h-3 w-3" />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-wrap break-words text-sm text-zinc-700">{item.text}</p>
                        <p className="mt-1 text-[12.5px] text-zinc-400">{formatRelativeTime(item.createdAt)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {resolved.length > 0 && (
                <div className="mt-6 flex flex-col gap-2">
                  <div className="px-1 text-[12px] font-medium uppercase tracking-wide text-zinc-400">Fixed</div>
                  {resolved.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-start gap-3 rounded-2xl border border-black/[0.07] bg-white/60 px-4 py-3"
                    >
                      <button
                        type="button"
                        onClick={() => toggleFeedbackResolved(item.id)}
                        aria-label="Mark as not fixed"
                        title="Mark as not fixed"
                        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white"
                      >
                        <CheckIcon className="h-3 w-3" />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-wrap break-words text-sm text-zinc-400 line-through decoration-zinc-300">
                          {item.text}
                        </p>
                        <p className="mt-1 text-[12.5px] text-zinc-400">{formatRelativeTime(item.createdAt)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
