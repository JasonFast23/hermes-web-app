"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useChatStore } from "@/lib/store";
import { pushToast, subscribeToasts, type ToastPayload } from "@/lib/notifications";

// Agent summaries lead with a bolded "**key fact**" (see the agents'
// system prompts in lib/agents.ts) — render that as actual bold instead of
// leaving literal asterisks in the toast. Mirrors MessageBubble's
// BOLD_PATTERN, minus the linkify/highlight machinery a toast doesn't need.
const BOLD_PATTERN = /\*\*([^\n*]+?)\*\*/g;

function renderBold(text: string) {
  const segments = text.split(BOLD_PATTERN);
  return segments.map((segment, i) =>
    i % 2 === 1 ? <strong key={i}>{segment}</strong> : <Fragment key={i}>{segment}</Fragment>
  );
}

interface Toast {
  id: string;
  title: string;
  body?: string;
  callId?: string;
  leaving: boolean;
}

const VISIBLE_MS = 5000;
const FADE_MS = 250;

// Subscribes to /api/notify's SSE stream for the lifetime of the app and
// renders each push as an in-app toast, top-right, that fades itself out —
// an iMessage-style bubble drawn by the app itself rather than the OS, so it
// shows up the same way no matter where in the app you are and doesn't
// depend on the browser's own notification permission.
export function NotificationListener() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const setView = useChatStore((s) => s.setView);
  const setPendingPhoneCallToOpen = useChatStore((s) => s.setPendingPhoneCallToOpen);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, FADE_MS);
  }, []);

  const addToast = useCallback(
    ({ title, body, callId }: ToastPayload) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setToasts((prev) => [...prev, { id, title, body, callId, leaving: false }]);
      setTimeout(() => dismiss(id), VISIBLE_MS);
    },
    [dismiss]
  );

  useEffect(() => {
    const source = new EventSource("/api/notify");
    // Relayed through pushToast (which already checks the mute flag)
    // rather than calling addToast directly, so anything else in the app
    // subscribed via subscribeToasts also sees a push that arrived over
    // SSE — not just same-tab ones. The phone-batch tracker in
    // lib/store.ts is exactly this: it needs to know the instant a call's
    // post-call analysis is ready (this same SSE push, from the phone
    // bridge's Retell webhook), and previously had no way to, since
    // nothing relayed an SSE event into subscribeToasts at all.
    source.onmessage = (event) => {
      try {
        pushToast(JSON.parse(event.data) as ToastPayload);
      } catch {
        // Ignore malformed push payloads.
      }
    };
    return () => source.close();
  }, []);

  // Same-tab pushes, plus SSE pushes relayed through pushToast above.
  useEffect(() => subscribeToasts(addToast), [addToast]);

  const handleClick = (t: Toast) => {
    if (t.callId) {
      setView("phone");
      setPendingPhoneCallToOpen(t.callId);
    }
    dismiss(t.id);
  };

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => handleClick(t)}
          className={`pointer-events-auto cursor-pointer rounded-2xl border border-black/[0.06] bg-white/95 px-4 py-3 shadow-lg backdrop-blur transition-all duration-200 ease-out ${
            t.leaving ? "translate-x-2 opacity-0" : "translate-x-0 opacity-100"
          }`}
        >
          <div className="text-[13.5px] font-semibold text-zinc-900">{renderBold(t.title)}</div>
          {t.body && <div className="mt-0.5 text-[12.5px] leading-snug text-zinc-500">{renderBold(t.body)}</div>}
        </div>
      ))}
    </div>
  );
}
