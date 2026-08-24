"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RetellWebClient } from "retell-client-js-sdk";
import { useChatStore } from "@/lib/store";
import { MenuIcon, PhoneIcon } from "@/components/Icons";

interface CallSummary {
  call_id: string;
  direction?: "inbound" | "outbound" | string;
  from_number?: string;
  to_number?: string;
  start_timestamp?: number;
  duration_ms?: number;
  call_status?: string;
  call_analysis?: {
    call_summary?: string;
    user_sentiment?: string;
    call_successful?: boolean;
  };
}

interface CallDetail extends CallSummary {
  transcript?: string;
  recording_url?: string;
}

// US numbers only (this whole feature is one Retell US number) — trims
// the +1 country code so the list reads as a normal phone number instead
// of raw E.164.
function formatPhoneNumber(raw: string | undefined): string {
  if (!raw) return "Unknown number";
  const digits = raw.replace(/^\+1/, "");
  const match = digits.match(/^(\d{3})(\d{3})(\d{4})$/);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : raw;
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDateTime(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function CallRow({ call, onClick }: { call: CallSummary; onClick: () => void }) {
  const isInbound = call.direction === "inbound";
  const counterpart = isInbound ? call.from_number : call.to_number;
  const summary = call.call_analysis?.call_summary;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-black/[0.03]"
    >
      <span
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] ${
          isInbound ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"
        }`}
        aria-hidden="true"
      >
        {isInbound ? "↙" : "↗"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-[14.5px] font-medium text-zinc-800">
            {isInbound ? "Incoming call" : "Outgoing call"} — {formatPhoneNumber(counterpart)}
          </span>
          <span className="shrink-0 text-[12px] text-zinc-400">{formatDateTime(call.start_timestamp)}</span>
        </span>
        {summary ? (
          <span className="mt-0.5 block truncate text-[12.5px] text-zinc-500">{summary}</span>
        ) : (
          <span className="mt-0.5 block text-[12.5px] text-zinc-400">
            {call.call_status === "ended" ? "No summary available" : call.call_status}
          </span>
        )}
      </span>
      {formatDuration(call.duration_ms) && (
        <span className="mt-0.5 shrink-0 text-[12px] text-zinc-400">{formatDuration(call.duration_ms)}</span>
      )}
    </button>
  );
}

function TranscriptView({ transcript }: { transcript: string }) {
  // Retell's plain-text transcript is already line-delimited as
  // "Agent: ..." / "User: ..." — split on that rather than pulling in a
  // parser for something this simple.
  const lines = transcript.split("\n").filter((l) => l.trim());

  return (
    <div className="flex flex-col gap-2">
      {lines.map((line, i) => {
        const isAgent = line.startsWith("Agent:");
        const text = line.replace(/^(Agent|User):\s*/, "");
        return (
          <div key={i} className={`flex ${isAgent ? "justify-start" : "justify-end"}`}>
            <div
              className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                isAgent ? "bg-white text-zinc-800 shadow-[0_1px_2px_rgba(0,0,0,0.04)]" : "bg-zinc-900 text-white"
              }`}
            >
              {text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CallDetailPanel({ callId, onBack }: { callId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Resets the previous call's detail/error before loading a new one —
    // callId changing means this instance is being reused for a different
    // call (same component, list stays mounted), not a fresh mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetail(null);
    setError(null);
    fetch(`/api/phone/calls/${callId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load call"))))
      .then((data: CallDetail) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load call");
      });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 border-b border-black/[0.06] px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-zinc-500 hover:text-zinc-800"
        >
          ← Back
        </button>
        {detail && (
          <span className="text-[13.5px] text-zinc-600">
            {detail.direction === "inbound" ? "Incoming call" : "Outgoing call"} —{" "}
            {formatPhoneNumber(detail.direction === "inbound" ? detail.from_number : detail.to_number)}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!error && !detail && <p className="text-sm text-zinc-400">Loading…</p>}
        {detail && (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-zinc-500">
              <span>{formatDateTime(detail.start_timestamp)}</span>
              {formatDuration(detail.duration_ms) && <span>Duration {formatDuration(detail.duration_ms)}</span>}
              {detail.call_analysis?.user_sentiment && <span>Sentiment: {detail.call_analysis.user_sentiment}</span>}
            </div>

            {detail.call_analysis?.call_summary && (
              <div className="rounded-2xl border border-black/[0.06] bg-white px-4 py-3">
                <p className="text-[12px] font-medium uppercase tracking-wide text-zinc-400">Summary</p>
                <p className="mt-1 text-[13.5px] leading-relaxed text-zinc-700">{detail.call_analysis.call_summary}</p>
              </div>
            )}

            {detail.recording_url && <audio controls src={detail.recording_url} className="w-full" />}

            {detail.transcript ? (
              <TranscriptView transcript={detail.transcript} />
            ) : (
              <p className="text-sm text-zinc-400">No transcript available for this call.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The original browser-mic simulated-call tools — still genuinely useful
// for testing changes to the phone bridge without spending real per-
// minute Retell/Twilio/TTS charges or needing an actual phone, but no
// longer the main reason this tab exists (see CallList above) now that
// there's a real number in production use. Kept, just demoted to a
// collapsed secondary section instead of the whole page.
function TestTools() {
  const [status, setStatus] = useState<"idle" | "connecting" | "active" | "ended" | "error">("idle");
  const [transcript, setTranscript] = useState<{ role: string; content: string }[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [task, setTask] = useState("");
  const clientRef = useRef<RetellWebClient | null>(null);

  const start = useCallback(async (endpoint: string, body?: object) => {
    setErrorMessage("");
    setTranscript([]);
    setStatus("connecting");

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok || !data.accessToken) {
        throw new Error(data.error || "Failed to create web call");
      }

      const client = new RetellWebClient();
      clientRef.current = client;

      client.on("call_started", () => setStatus("active"));
      client.on("call_ended", () => setStatus("ended"));
      client.on("error", (err: unknown) => {
        console.error("Retell call error:", err);
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setStatus("error");
        client.stopCall();
      });
      client.on("update", (update: { transcript?: { role: string; content: string }[] }) => {
        if (update.transcript) setTranscript(update.transcript);
      });

      await client.startCall({ accessToken: data.accessToken });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  const stop = useCallback(() => {
    clientRef.current?.stopCall();
    setStatus("ended");
  }, []);

  const busy = status === "connecting" || status === "active";

  return (
    <div className="flex flex-col gap-6 p-4">
      <p className="text-sm text-zinc-500">
        Talks to Eva through the Retell voice agent over your browser mic — no phone number
        involved, but it goes through the exact same bridge a real phone call would use. Useful
        for testing changes without a real call.
      </p>

      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium text-zinc-700">Inbound (someone calls Eva)</div>
        <div className="flex gap-3">
          <button
            onClick={() => start("/api/phone-test/create-web-call")}
            disabled={busy}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {status === "connecting" ? "Connecting…" : "Start call"}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-zinc-200 pt-5">
        <div className="text-sm font-medium text-zinc-700">Outbound (Eva calls out to find something out)</div>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          disabled={busy}
          placeholder="e.g. Ask what tomorrow's court filing deadline is and confirm the case number"
          rows={2}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:opacity-40"
        />
        <button
          onClick={() => start("/api/phone-test/create-outbound-web-call", { task })}
          disabled={busy || !task.trim()}
          className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {status === "connecting" ? "Connecting…" : "Start outbound test call"}
        </button>
      </div>

      <div className="flex items-center gap-3 border-t border-zinc-200 pt-5">
        <button
          onClick={stop}
          disabled={status !== "active"}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-40"
        >
          End call
        </button>
        <div className="text-sm text-zinc-500">Status: {status}</div>
      </div>

      {errorMessage && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</div>
      )}

      <div className="flex flex-col gap-2">
        {transcript.map((turn, i) => (
          <div key={i} className="text-sm">
            <span className="font-medium">{turn.role === "agent" ? "Eva" : "You"}:</span> {turn.content}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PhonePage() {
  const setMobileSidebarOpen = useChatStore((s) => s.setMobileSidebarOpen);
  const [calls, setCalls] = useState<CallSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTestTools, setShowTestTools] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/phone/calls")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load call history"))))
      .then((data: { calls: CallSummary[] }) => {
        if (!cancelled) setCalls(data.calls);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load call history");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Opening a call is local component state, not a real route change — so
  // without this, the phone's hardware/gesture back button has no browser
  // history entry to act on and does nothing (or leaves the page
  // entirely), even though the on-screen "← Back" link works fine for a
  // tap. Pushing a history entry when a call opens, and closing the
  // detail view on popstate, makes the system back button behave exactly
  // like the on-screen one — both end up going through this same
  // listener, via history.back() below, so they can never fall out of
  // sync with each other.
  useEffect(() => {
    if (!selectedId) return;
    window.history.pushState({ phoneCallDetail: selectedId }, "");
    const handlePopState = () => setSelectedId(null);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [selectedId]);

  const openCall = (callId: string) => setSelectedId(callId);
  const closeCall = () => window.history.back();

  if (selectedId) {
    return (
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#f4f6fb]">
        <CallDetailPanel callId={selectedId} onBack={closeCall} />
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#f4f6fb]">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-black/[0.06] px-3 pt-[env(safe-area-inset-top)] sm:px-6">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setMobileSidebarOpen(true)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-black/[0.04] md:hidden"
          >
            <MenuIcon className="h-[19px] w-[19px]" />
          </button>
          <h1 className="text-xl font-semibold text-zinc-800">Phone</h1>
        </div>
        <button
          type="button"
          onClick={() => setShowTestTools((v) => !v)}
          className="rounded-md bg-zinc-200 px-3 py-1.5 text-[13px] font-medium text-zinc-700 hover:bg-zinc-300"
        >
          {showTestTools ? "Hide test tools" : "Test tools"}
        </button>
      </div>

      {showTestTools && (
        <div className="shrink-0 border-b border-black/[0.06]">
          <TestTools />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {error && <p className="px-4 py-8 text-center text-sm text-red-600">{error}</p>}
        {!error && !calls && <p className="px-4 py-8 text-center text-sm text-zinc-400">Loading…</p>}
        {!error && calls && calls.length === 0 && (
          <p className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-zinc-400">
            <PhoneIcon className="h-6 w-6 text-zinc-300" />
            No calls yet.
          </p>
        )}
        {calls?.map((call) => (
          <CallRow key={call.call_id} call={call} onClick={() => openCall(call.call_id)} />
        ))}
      </div>
    </section>
  );
}
