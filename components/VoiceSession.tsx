"use client";

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/lib/store";
import { pickRecorderMimeType, extForMimeType } from "@/lib/audio";
import { XIcon } from "./Icons";

type Status =
  | "connecting"
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

// Address of the standalone voice-relay service (scripts/voice-relay-server.mjs)
// — a persistent WebSocket connection to ElevenLabs' streaming endpoint, kept
// open for the whole turn so Eva's text deltas can be forwarded as they
// generate instead of waiting for a complete sentence and paying a fresh
// HTTP round trip per sentence. Always points at wherever that relay process
// actually runs (the same host as the Hermes backends), regardless of
// whether this app itself is being served from there or from a local dev
// server — it's not derived from window.location for that reason.
const VOICE_RELAY_WS_URL = process.env.NEXT_PUBLIC_VOICE_RELAY_WS_URL;

// ElevenLabs audibly emphasizes markdown emphasis markers — wrapping a
// word in ** genuinely changes its spoken tone/stress, confirmed by ear,
// not just leaving literal asterisks in the audio. Telling the model not
// to use markdown isn't reliable enough on its own (her own text-chat
// prompt tells her to bold the direct answer, and that instruction wins
// out here often enough to matter), so this is stripped unconditionally
// before anything reaches TTS, regardless of what she actually wrote.
// Applied per raw delta now rather than per complete sentence — a markdown
// pair split exactly across a delta boundary can rarely slip through, but
// VOICE_MODE_CONTEXT already tells her not to use markdown in the first
// place, so this remains a backstop, not the primary defense.
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "");
}

export function VoiceSession({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const micStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const closedRef = useRef(false);

  // --- Gapless PCM playback (Web Audio API) -----------------------------
  // Each incoming chunk is scheduled to start exactly when the previous one
  // ends, using the AudioContext's own clock — sample-accurate regardless
  // of how the relay happens to size its chunks, unlike the old approach
  // of playing back independently-synthesized MP3 files one at a time.
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const askEva = useChatStore((s) => s.askEva);
  const voiceVolume = useChatStore((s) => s.voiceVolume);

  useEffect(() => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = voiceVolume;
  }, [voiceVolume]);

  // Created lazily but from within the same call stack as the user's tap
  // (startRecording runs synchronously up to its first await), so browser
  // autoplay policy treats it as gesture-initiated instead of blocking it.
  const ensureAudioContext = () => {
    if (!audioContextRef.current) {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.gain.value = voiceVolume;
      gain.connect(ctx.destination);
      audioContextRef.current = ctx;
      gainNodeRef.current = gain;
    }
    return audioContextRef.current;
  };

  const stopAllPlayback = () => {
    for (const source of activeSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped/ended — fine.
      }
    }
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  // Decodes a base64 chunk of raw 16-bit signed little-endian mono PCM
  // (see OUTPUT_FORMAT in scripts/voice-relay-server.mjs) and schedules it
  // right after whatever's already queued.
  const playPcmChunk = (base64: string, sampleRate: number) => {
    const ctx = ensureAudioContext();
    const gain = gainNodeRef.current;
    if (!gain) return;

    const binary = atob(base64);
    const byteLength = binary.length;
    const sampleCount = Math.floor(byteLength / 2);
    if (sampleCount === 0) return;

    const bytes = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i++) bytes[i] = binary.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      float32[i] = view.getInt16(i * 2, true) / 32768;
    }

    const buffer = ctx.createBuffer(1, sampleCount, sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const startAt = Math.max(ctx.currentTime, nextStartTimeRef.current);
    source.start(startAt);
    nextStartTimeRef.current = startAt + buffer.duration;
    activeSourcesRef.current.add(source);
    source.onended = () => activeSourcesRef.current.delete(source);
  };
  // ------------------------------------------------------------------------

  // --- Timing diagnostics -------------------------------------------------
  // Kept from the previous pipeline to confirm the WebSocket switch actually
  // closes the gap it was meant to close. Remove once confirmed.
  const turnStartRef = useRef(0);
  const mark = (label: string, extra?: Record<string, unknown>) => {
    const elapsed = Math.round(performance.now() - turnStartRef.current);
    console.log(`[voice +${elapsed}ms] ${label}`, extra ?? "");
  };
  // ------------------------------------------------------------------------

  const probeMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setStatus("idle");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Microphone access denied");
      setStatus("error");
    }
  };

  const retryMic = () => {
    setStatus("connecting");
    setErrorMessage(null);
    void probeMic();
  };

  useEffect(() => {
    // One-time mic-permission probe on mount — the lint rule can't see past
    // the await in probeMic to know the setState calls aren't synchronous.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void probeMic();
  }, []);

  // The one thing that must never be spoken is a raw [[DELEGATE:...]]
  // marker: when she's handing off to Research/Email, her entire reply
  // (per her base prompt) IS that marker line and nothing else, so there
  // is genuinely nothing to say for that turn — the Approve/Decline card
  // covers it visually. "[[DELEGATE:".length characters are buffered
  // before anything is committed to speech, just enough to tell the two
  // cases apart with no meaningful added latency.
  const DELEGATE_PREFIX = "[[DELEGATE:";

  // Opens one voice-relay connection for this turn and forwards Eva's text
  // deltas to it as she generates them, so ElevenLabs keeps one continuous
  // generation running instead of synthesizing independent per-sentence
  // clips. `finished` resolves once all scheduled audio has actually
  // finished playing (not just once the last chunk was received) — always
  // resolves eventually, on every exit path, so a relay/network hiccup can
  // never leave the caller awaiting forever.
  const streamToRelay = (signal: AbortSignal): { onDelta: (delta: string) => void; end: () => void; finished: Promise<void> } => {
    if (!VOICE_RELAY_WS_URL) {
      console.error("NEXT_PUBLIC_VOICE_RELAY_WS_URL is not configured");
      return { onDelta: () => {}, end: () => {}, finished: Promise.resolve() };
    }

    let sniff = "";
    let resolved = false;
    let isDelegating = false;
    let firstAudioReceived = false;
    let wsOpen = false;
    let ended = false;
    let settled = false;

    const pendingText: string[] = [];
    const ws = new WebSocket(VOICE_RELAY_WS_URL);

    let resolveFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    const settle = () => {
      if (settled) return;
      settled = true;
      const ctx = audioContextRef.current;
      const remainingMs = ctx ? Math.max(0, (nextStartTimeRef.current - ctx.currentTime) * 1000) : 0;
      setTimeout(resolveFinished, remainingMs);
    };

    const sendText = (text: string) => {
      const clean = stripMarkdownForSpeech(text);
      if (!clean) return;
      if (wsOpen) ws.send(JSON.stringify({ type: "text", text: clean }));
      else pendingText.push(clean);
    };

    ws.onopen = () => {
      mark("relay: connected");
      wsOpen = true;
      for (const t of pendingText.splice(0)) ws.send(JSON.stringify({ type: "text", text: t }));
      if (ended) ws.send(JSON.stringify({ type: "end" }));
    };

    ws.onmessage = (event) => {
      if (signal.aborted) return;
      let msg: { type?: string; audio?: string; sampleRate?: number; message?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "audio" && msg.audio) {
        if (!firstAudioReceived) {
          firstAudioReceived = true;
          mark("relay: first audio chunk received");
          setStatus("speaking");
        }
        playPcmChunk(msg.audio, msg.sampleRate ?? 24000);
      } else if (msg.type === "done") {
        mark("relay: done (last chunk received)");
        settle();
      } else if (msg.type === "error") {
        console.error("Voice relay error:", msg.message);
        settle();
      }
    };

    ws.onerror = () => {
      if (!signal.aborted) console.error("Voice relay connection failed");
      settle();
    };
    ws.onclose = () => settle();

    if (signal.aborted) {
      ws.close();
      settle();
    } else {
      signal.addEventListener(
        "abort",
        () => {
          ws.close();
          settle();
        },
        { once: true }
      );
    }

    const onDelta = (delta: string) => {
      if (resolved) {
        if (!isDelegating) sendText(delta);
        return;
      }
      sniff += delta;
      // Streamed chunks aren't guaranteed to arrive one character at a
      // time — a single delta can easily carry the whole marker line (or
      // a whole ordinary sentence) at once, so the "still ambiguous"
      // check only makes sense while sniff is still shorter than the
      // prefix. Once it's at least as long, decide for real by checking
      // sniff itself, not the other way around — a short string can never
      // "start with" a longer one.
      if (sniff.length < DELEGATE_PREFIX.length) {
        if (DELEGATE_PREFIX.startsWith(sniff)) return; // still ambiguous — need more
        resolved = true;
        isDelegating = false;
        sendText(sniff);
        return;
      }
      resolved = true;
      isDelegating = sniff.startsWith(DELEGATE_PREFIX);
      if (!isDelegating) sendText(sniff);
    };

    const end = () => {
      ended = true;
      if (wsOpen) ws.send(JSON.stringify({ type: "end" }));
    };

    return { onDelta, end, finished };
  };

  const processTurn = async (blob: Blob, ext: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    stopAllPlayback();
    turnStartRef.current = performance.now();
    mark("turn start (recording stopped)");

    try {
      setStatus("transcribing");
      mark("stt: request start");
      const form = new FormData();
      form.append("audio", blob, `recording.${ext}`);
      const sttRes = await fetch("/api/voice/stt", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const sttData = await sttRes.json();
      if (!sttRes.ok) throw new Error(sttData?.error || "Transcription failed");
      mark("stt: got transcript");

      const transcript = typeof sttData.text === "string" ? sttData.text.trim() : "";
      if (!transcript) {
        setStatus("idle");
        return;
      }

      setStatus("thinking");
      mark("llm: askEva call start");

      const { onDelta, end, finished } = streamToRelay(controller.signal);
      await askEva(transcript, undefined, onDelta);
      mark("llm: askEva call resolved (full text done generating)");
      end();

      await finished;
      mark("turn done (all audio finished playing)");
      if (!controller.signal.aborted) setStatus("idle");
    } catch (err) {
      if (controller.signal.aborted) return;
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong");
      setStatus("error");
    }
  };

  const startRecording = async () => {
    setErrorMessage(null);
    // Tied to this same click's call stack (before any await) so the
    // browser treats AudioContext creation as user-gesture-initiated.
    ensureAudioContext();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const mimeType = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      discardRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        micStreamRef.current?.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;

        if (discardRef.current) {
          setStatus("idle");
          return;
        }

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType });
        void processTurn(blob, extForMimeType(recorder.mimeType || mimeType));
      };

      recorderRef.current = recorder;
      recorder.start();
      setStatus("recording");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Microphone access denied");
      setStatus("error");
    }
  };

  const stopRecording = () => {
    discardRef.current = false;
    recorderRef.current?.stop();
  };

  const cancelRecording = () => {
    discardRef.current = true;
    recorderRef.current?.stop();
  };

  // Tap-to-interrupt: cuts off whatever's in flight (transcribing, Eva
  // thinking, or her speaking) and immediately starts listening for the
  // next thing. Every async step in processTurn/streamToRelay already
  // checks this same AbortController's signal, so aborting here is enough
  // to stop future audio from being scheduled — we only need to
  // explicitly stop audio that's *already* scheduled/playing, since
  // aborting the signal doesn't silence a Web Audio source on its own.
  const interrupt = () => {
    abortRef.current?.abort();
    stopAllPlayback();
    void startRecording();
  };

  const handleCircleClick = () => {
    if (status === "idle") {
      void startRecording();
    } else if (status === "recording") {
      stopRecording();
    } else if (status === "error") {
      retryMic();
    } else if (status === "transcribing" || status === "thinking" || status === "speaking") {
      interrupt();
    }
  };

  const close = () => {
    if (closedRef.current) return;
    closedRef.current = true;

    abortRef.current?.abort();
    recorderRef.current?.stop();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;

    stopAllPlayback();
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;

    onClose();
  };

  useEffect(() => {
    return () => {
      if (!closedRef.current) {
        abortRef.current?.abort();
        recorderRef.current?.stop();
        micStreamRef.current?.getTracks().forEach((t) => t.stop());
        stopAllPlayback();
        audioContextRef.current?.close().catch(() => {});
      }
    };
  }, []);

  const statusLabel: Record<Status, string> = {
    connecting: "Preparing microphone…",
    idle: "Tap to speak",
    recording: "Listening… tap to stop",
    transcribing: "Transcribing… tap to interrupt",
    thinking: "Asking Eva… tap to interrupt",
    speaking: "Speaking… tap to interrupt",
    error: "Connection failed",
  };

  const circleDisabled = status === "connecting";

  return (
    <div className="flex items-center gap-3 rounded-full border border-black/[0.07] bg-white px-3 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.05)]">
      <button
        type="button"
        onClick={handleCircleClick}
        disabled={circleDisabled}
        aria-label={statusLabel[status]}
        className={`h-9 w-9 shrink-0 rounded-full bg-zinc-900 transition-transform duration-300 disabled:cursor-default ${
          status === "speaking" ? "scale-110" : status === "transcribing" || status === "thinking" ? "scale-90 opacity-70" : "scale-100"
        } ${status === "recording" ? "animate-pulse" : ""}`}
      />

      <span className="flex-1 truncate text-[13.5px] font-medium text-zinc-600">
        {status === "error" ? errorMessage || statusLabel.error : statusLabel[status]}
      </span>

      {status === "recording" && (
        <button
          type="button"
          onClick={cancelRecording}
          className="shrink-0 rounded-full bg-zinc-100 px-3.5 py-1.5 text-[13px] font-medium text-zinc-700 hover:bg-zinc-200"
        >
          Cancel
        </button>
      )}

      <button
        type="button"
        onClick={close}
        aria-label="Close voice session"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-600"
      >
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
