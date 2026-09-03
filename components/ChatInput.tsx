"use client";

import { useEffect, useRef, useState, ChangeEvent, FormEvent } from "react";
import { useChatStore } from "@/lib/store";
import { ArrowUpIcon, FileIcon, PaperclipIcon, StopIcon, WaveformIcon } from "./Icons";
import { VoiceSession } from "./VoiceSession";

const ACCEPTED_FILE_TYPES = ".pdf,.xlsx,.xls,.csv";

export function ChatInput() {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const queueMessage = useChatStore((s) => s.queueMessage);
  const removeQueuedMessage = useChatStore((s) => s.removeQueuedMessage);
  const messageQueue = useChatStore((s) => s.messageQueue);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
  const setActiveAgent = useChatStore((s) => s.setActiveAgent);
  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const queuedHere = messageQueue.filter(
    (q) => q.sessionId === activeSessionId && q.agentId === activeAgentId
  );
  const voiceOpen = useChatStore((s) => s.voiceOpen);
  const setVoiceOpen = useChatStore((s) => s.setVoiceOpen);
  const attachFile = useChatStore((s) => s.attachFile);
  const removeAttachedFile = useChatStore((s) => s.removeAttachedFile);
  const pendingUploads = useChatStore((s) => s.pendingUploads);
  const sessions = useChatStore((s) => s.sessions);
  // File upload only makes sense on Eva's tab for now — she's the one the
  // user is meant to be talking to, and the extraction/context plumbing
  // (buildFileContext) only feeds her turns. See lib/store.ts.
  const attachedFiles =
    activeAgentId === "jarvis"
      ? (sessions.find((s) => s.id === activeSessionId)?.attachedFiles ?? [])
      : [];

  // The Stop and Send/Voice buttons occupy the same spot, swapping based on
  // isStreaming. If a request finishes right as the user clicks Stop, the
  // click can land on the freshly-idle Send/Voice button instead — and with
  // no text typed, that opens voice mode. Suppress that for a brief window
  // right after streaming ends so a stop-click can't be reinterpreted as a
  // voice-mode request.
  const wasStreamingRef = useRef(isStreaming);
  const suppressVoiceUntilRef = useRef(0);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      suppressVoiceUntilRef.current = Date.now() + 600;
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const submit = () => {
    const trimmed = text.trim();

    if (!trimmed) {
      if (Date.now() < suppressVoiceUntilRef.current) return;
      // Voice always talks to Eva (jarvis) — switch to her tab so the
      // session/delegation state (approval cards, activity log) it relies
      // on is the same one voice mode operates on. ChatPanel hides the
      // scrolling thread itself while voiceOpen is true (see there).
      setActiveAgent("jarvis");
      setVoiceOpen(true);
      return;
    }
    if (isStreaming) {
      // Still busy — hold the message instead of dropping it. It's sent
      // automatically the moment this tab is free (see drainMessageQueue),
      // so the user can keep handing Eva more without waiting on, or
      // stopping, what she's already doing.
      queueMessage(trimmed);
      setText("");
      return;
    }

    sendMessage(trimmed);
    setText("");
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-selecting the same file later
    for (const file of files) void attachFile(file);
  };

  // Grow the textarea to fit its content (up to the CSS max-height, where
  // it starts scrolling instead) rather than staying a fixed height and
  // scrolling internally the whole time. Coalesced onto a single rAF per
  // frame rather than running synchronously on every `text` change, since a
  // synchronous layout reflow (set height:auto, then immediately read
  // scrollHeight) on every keystroke is what made typing feel janky.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    });
    return () => cancelAnimationFrame(raf);
  }, [text]);

  const hasText = text.trim().length > 0;
  // Priscilla's meant to deal with Eva, not the specialists directly — she
  // was landing on Research/Email's tab mid-delegation and typing into it
  // by accident, thinking she was still talking to Eva. delegateToAgent no
  // longer force-navigates her there (see lib/store.ts), but the tabs
  // themselves were still typeable, so a stray click could cause the same
  // mix-up. Their tabs stay viewable (activity history, the delegation
  // "View" link) — only the ability to type a NEW message into them is
  // removed.
  const isSpecialistTab = activeAgentId === "email" || activeAgentId === "graphic";

  return (
    <form
      onSubmit={handleSubmit}
      className="px-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6"
    >
      <div className="mx-auto w-full max-w-2xl">
        {activeAgentId === "jarvis" && (attachedFiles.length > 0 || pendingUploads.length > 0) && !voiceOpen && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachedFiles.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-white py-1 pl-2.5 pr-1.5 text-[12.5px] text-zinc-600 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                title={f.truncated ? `${f.filename} (only part of this file was read)` : f.filename}
              >
                <FileIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                <span className="max-w-[160px] truncate">{f.filename}</span>
                <button
                  type="button"
                  onClick={() => removeAttachedFile(f.id)}
                  aria-label={`Remove ${f.filename}`}
                  title="Remove"
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-black/[0.06] hover:text-zinc-700"
                >
                  ×
                </button>
              </div>
            ))}
            {pendingUploads.map((name) => (
              <div
                key={name}
                className="flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-white py-1 pl-2.5 pr-3 text-[12.5px] text-zinc-400 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
              >
                <FileIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-[160px] truncate">{name}</span>
                <span>reading…</span>
              </div>
            ))}
          </div>
        )}
        {queuedHere.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            {queuedHere.map((q) => (
              <div
                key={q.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-black/[0.07] bg-white px-3 py-1.5 text-[13px] text-zinc-500 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
              >
                <span className="min-w-0 truncate">
                  <span className="text-zinc-400">Queued: </span>
                  {q.text}
                </span>
                <button
                  type="button"
                  onClick={() => removeQueuedMessage(q.id)}
                  aria-label="Remove queued message"
                  title="Remove"
                  className="shrink-0 text-zinc-400 hover:text-zinc-700"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {/* The Fast/Deep toggle that used to live here only ever affected a
            direct message typed into Research's own tab — Eva's own
            delegations are hardcoded to fast (see lib/store.ts's
            researchMode comment) — so it has nothing left to control now
            that typing here is disabled (see isSpecialistTab). Deep mode
            is consequently unreachable from the UI until/unless Eva grows
            a way to ask for it on the user's behalf. */}

        {voiceOpen ? (
          <VoiceSession onClose={() => setVoiceOpen(false)} />
        ) : isSpecialistTab ? (
          <div className="flex items-center justify-between gap-3 rounded-3xl border border-black/[0.07] bg-zinc-50 px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <span className="text-sm text-zinc-400">Message Eva instead — she&apos;ll route this to the right specialist.</span>
            <button
              type="button"
              onClick={() => setActiveAgent("jarvis")}
              className="shrink-0 rounded-full bg-zinc-900 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-zinc-700"
            >
              Go to Eva
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-3xl border border-black/[0.07] bg-white px-2 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.05)]">
            {activeAgentId === "jarvis" && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_FILE_TYPES}
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach a file"
                  title="Attach a PDF, Excel, or CSV file"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/[0.05]"
                >
                  <PaperclipIcon className="h-[18px] w-[18px]" />
                </button>
              </>
            )}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder={
                isStreaming
                  ? "Add another message — it'll send once this is done…"
                  : "Message… (Shift+Enter for a new line)"
              }
              className="max-h-[60vh] flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1.5 text-sm text-zinc-700 outline-none placeholder:text-zinc-400"
            />

            {isStreaming ? (
              <button
                key="stop-btn"
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  stopStreaming();
                }}
                aria-label="Stop generating"
                title="Stop generating"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-opacity hover:opacity-80"
              >
                <StopIcon className="h-[16px] w-[16px]" />
              </button>
            ) : (
              <button
                key="submit-btn"
                type="submit"
                aria-label={hasText ? "Send message" : "Start voice session"}
                title={hasText ? "Send message" : "Start voice session"}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-opacity disabled:opacity-40"
              >
                {hasText ? (
                  <ArrowUpIcon className="h-[18px] w-[18px]" />
                ) : (
                  <WaveformIcon className="h-[18px] w-[18px]" />
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
