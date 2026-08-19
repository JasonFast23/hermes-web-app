"use client";

import { useEffect, useMemo, useRef } from "react";
import { useChatStore } from "@/lib/store";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { PendingDelegationCard } from "./PendingDelegationCard";
import { VoiceOrb } from "./VoiceOrb";

function greetingForHour(hour: number): string {
  if (hour < 5) return "Good Evening";
  if (hour < 12) return "Good Morning";
  if (hour < 18) return "Good Afternoon";
  return "Good Evening";
}

export function ChatPanel() {
  const sessions = useChatStore((s) => s.sessions);
  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const error = useChatStore((s) => s.error);
  const scrollToMessage = useChatStore((s) => s.scrollToMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const voiceOpen = useChatStore((s) => s.voiceOpen);
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(
    () => sessions.find((s) => s.id === activeSessionId)?.threads[activeAgentId] ?? [],
    [sessions, activeSessionId, activeAgentId]
  );

  // A search-result navigation scrolls to the specific matched message.
  useEffect(() => {
    if (!scrollToMessage || !messages.some((m) => m.id === scrollToMessage.messageId)) return;
    document
      .getElementById(`msg-${scrollToMessage.messageId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [scrollToMessage, messages]);

  // Scroll to the bottom on new messages or switching threads. Deliberately
  // depends on `messages` ONLY — not scrollToMessage — even though it reads
  // scrollToMessage's value: MessageBubble clears scrollToMessage itself
  // once its highlight fade completes (see its own comment for why), and
  // that clear must NOT be a trigger for this effect, or every search
  // highlight would yank the view down to the bottom a couple seconds
  // after landing on it. Including scrollToMessage in the deps array would
  // do exactly that — re-run this effect on the clear, at which point the
  // guard below is already false and it falls through to the bottom-scroll.
  useEffect(() => {
    if (scrollToMessage) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  return (
    <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -bottom-32 -right-24 h-[520px] w-[520px] rounded-full bg-gradient-to-tr from-indigo-200/40 via-slate-200/30 to-transparent blur-3xl" />
        <div className="absolute -top-24 left-1/3 h-[360px] w-[360px] rounded-full bg-gradient-to-br from-sky-100/40 to-transparent blur-3xl" />
      </div>

      {voiceOpen && activeAgentId === "jarvis" ? (
        // Hide Eva's own thread specifically — reading her reply while also
        // hearing it is what this avoids (see the voiceOpen comment in
        // lib/store.ts). Scoped to her tab only, not voiceOpen in general:
        // delegateToAgent/runEvaAfterDelegation already switch activeAgentId
        // to Research/Email while a hand-off is actually running, and that
        // work was never being spoken anyway — the point is to stop reading
        // along with your own ears, not to hide everything happening.
        // Falling through to the normal thread view for any other tab
        // means that work stays fully visible during a voice session.
        <div className="relative flex flex-1 flex-col items-center justify-center px-6 text-center">
          <VoiceOrb />
        </div>
      ) : messages.length === 0 ? (
        <div className="relative flex flex-1 flex-col items-center justify-center px-6 text-center">
          <h1 className="font-[family-name:var(--font-display)] text-6xl leading-none tracking-tight text-zinc-400/70 sm:text-7xl">
            AiPX Agent
          </h1>
          <p
            className="mt-6 whitespace-nowrap text-lg leading-relaxed text-zinc-400 sm:text-xl"
            suppressHydrationWarning
          >
            {greetingForHour(new Date().getHours())} Priscilla!
          </p>

        </div>
      ) : (
        <div className="relative flex-1 space-y-3 overflow-y-auto p-4">
          {messages.map((message, i) => {
            // A delegate-marker message ends up with empty content once the
            // marker is stripped out (see processDelegateMarker) — nothing
            // more is ever coming for it, since the real follow-up (Eva's
            // hand-off line, or her next turn) lands in a separate message.
            // Rendering it as a permanently-blinking empty bubble was
            // confusing (looked stuck "typing" forever); skip it entirely
            // unless it's still the one actually streaming right now.
            const isEmpty =
              message.role === "assistant" && !message.content && !message.toolEvents?.length;
            const isActivelyStreaming = isStreaming && i === messages.length - 1;
            if (isEmpty && !isActivelyStreaming) return null;

            const highlightQuery = scrollToMessage?.messageId === message.id ? scrollToMessage.query : undefined;
            return (
              <div key={message.id} id={`msg-${message.id}`}>
                {/* Keyed on whether this message is *starting* to be the
                    search-highlight target, so MessageBubble remounts fresh
                    (glow seeded true) instead of needing an effect to reach
                    back and flip it on after the fact. */}
                <MessageBubble key={highlightQuery ? "hl" : "plain"} message={message} highlightQuery={highlightQuery} />
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}

      {error && (
        <p className="relative border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      <div className="relative px-4">
        <PendingDelegationCard />
      </div>

      <div className="relative">
        <ChatInput />
      </div>
    </section>
  );
}
