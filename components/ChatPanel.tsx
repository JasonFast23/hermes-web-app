"use client";

import { useEffect, useMemo, useRef } from "react";
import { useChatStore } from "@/lib/store";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { PendingDelegationCard } from "./PendingDelegationCard";

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
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(
    () => sessions.find((s) => s.id === activeSessionId)?.threads[activeAgentId] ?? [],
    [sessions, activeSessionId, activeAgentId]
  );

  // A search-result navigation scrolls to the specific matched message
  // instead of the bottom; otherwise (new message, agent/session switch)
  // scroll to the bottom as before. Guarding on scrollToMessage keeps the
  // two behaviors from racing on the same render. Clearing scrollToMessage
  // itself is MessageBubble's job (tied to its own highlight fade timer,
  // not a separate one here — see its comment for why).
  useEffect(() => {
    if (scrollToMessage && messages.some((m) => m.id === scrollToMessage.messageId)) {
      document
        .getElementById(`msg-${scrollToMessage.messageId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, scrollToMessage]);

  return (
    <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -bottom-32 -right-24 h-[520px] w-[520px] rounded-full bg-gradient-to-tr from-indigo-200/40 via-slate-200/30 to-transparent blur-3xl" />
        <div className="absolute -top-24 left-1/3 h-[360px] w-[360px] rounded-full bg-gradient-to-br from-sky-100/40 to-transparent blur-3xl" />
      </div>

      {messages.length === 0 ? (
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
          {messages.map((message) => {
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
