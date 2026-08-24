"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { RetellWebClient } from "retell-client-js-sdk";

type CallStatus = "idle" | "connecting" | "active" | "ended" | "error";

interface TranscriptTurn {
  role: string;
  content: string;
}

export default function PhoneTestPage() {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
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
      client.on("update", (update: { transcript?: TranscriptTurn[] }) => {
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
    <div className="mx-auto flex min-h-screen max-w-lg flex-col gap-6 px-6 py-16">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800">
        ← Back to Eva
      </Link>

      <div>
        <h1 className="text-xl font-semibold">Phone bridge test call</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Talks to Eva through the Retell voice agent over your browser mic —
          no phone number involved, but it goes through the exact same
          bridge a real phone call would use.
        </p>
      </div>

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
        <div className="text-sm font-medium text-zinc-700">
          Outbound (Eva calls out to find something out)
        </div>
        <p className="text-sm text-zinc-500">
          Simulates Eva placing a call with a purpose — same as she would to
          a real phone number, minus actually dialing one. You play the
          person she&apos;s calling.
        </p>
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
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {transcript.map((turn, i) => (
          <div key={i} className="text-sm">
            <span className="font-medium">{turn.role === "agent" ? "Eva" : "You"}:</span>{" "}
            {turn.content}
          </div>
        ))}
      </div>
    </div>
  );
}
