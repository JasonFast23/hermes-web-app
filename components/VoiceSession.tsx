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

// Answers at or under this word count are already about as short as a
// "few sentences" summary would be — skip the extra condense round trip.
const CONDENSE_SKIP_WORD_COUNT = 40;

const SENTENCE_BOUNDARY = /[.!?]+[)"'”]?(?:\s+|$)/;
const MAX_BUFFER = 220;

// Buffers streamed text and emits complete sentences as they're detected,
// so TTS can start on the first sentence of the condensed summary while
// the condense model is still generating the rest of it.
function createSentenceChunker(onSentence: (text: string) => void) {
  let buffer = "";
  const drain = () => {
    for (;;) {
      const match = SENTENCE_BOUNDARY.exec(buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      const sentence = buffer.slice(0, end).trim();
      buffer = buffer.slice(end);
      if (sentence) onSentence(sentence);
    }
    if (buffer.length > MAX_BUFFER) {
      const cut = Math.max(buffer.lastIndexOf(", "), buffer.lastIndexOf(" "));
      const splitAt = cut > 0 ? cut + 1 : MAX_BUFFER;
      const sentence = buffer.slice(0, splitAt).trim();
      buffer = buffer.slice(splitAt);
      if (sentence) onSentence(sentence);
    }
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      drain();
    },
    flush() {
      const remainder = buffer.trim();
      buffer = "";
      if (remainder) onSentence(remainder);
    },
  };
}

// Consumes the SSE stream from /api/voice/condense (plain OpenAI-compatible
// chat-completion chunks — same shape as Hermes' stream, just no tool
// events) and reports each text delta as it arrives.
async function streamCondense(text: string, onDelta: (chunk: string) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch("/api/voice/condense", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || "Condense request failed");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamDone = false;

  while (!streamDone) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith("data:")) continue;

      const data = trimmedLine.slice(5).trim();
      if (data === "[DONE]") {
        streamDone = true;
        break;
      }

      try {
        const parsed = JSON.parse(data);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) onDelta(delta);
      } catch (err) {
        console.error("Failed to parse SSE chunk from condense:", data, err);
      }
    }
  }
}

export function VoiceSession({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const micStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const closedRef = useRef(false);
  const speechChainRef = useRef<Promise<void>>(Promise.resolve());
  const askEva = useChatStore((s) => s.askEva);
  const voiceVolume = useChatStore((s) => s.voiceVolume);

  // Keep the currently-playing (or about-to-play) clip in sync if the
  // volume slider is adjusted mid-speech, not just on the next clip.
  useEffect(() => {
    if (audioElRef.current) audioElRef.current.volume = voiceVolume;
  }, [voiceVolume]);

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

  const revokeObjectUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  const playBlob = (blob: Blob, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted || !audioElRef.current) {
        resolve();
        return;
      }
      revokeObjectUrl();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audioEl = audioElRef.current;
      audioEl.src = url;
      const cleanup = () => {
        audioEl.onended = null;
        audioEl.onerror = null;
        resolve();
      };
      audioEl.onended = cleanup;
      audioEl.onerror = cleanup;
      audioEl.play().catch(cleanup);
    });

  const enqueueSpeechFromPromise = (blobPromise: Promise<Blob | null>, signal: AbortSignal) => {
    if (signal.aborted) return;
    speechChainRef.current = speechChainRef.current.then(async () => {
      if (signal.aborted) return;
      let blob: Blob | null = null;
      try {
        blob = await blobPromise;
      } catch {
        blob = null;
      }
      if (!blob || signal.aborted) return;
      await playBlob(blob, signal);
    });
  };

  const enqueueSpeech = (text: string, signal: AbortSignal) => {
    const trimmed = text.trim();
    if (!trimmed || signal.aborted) return;
    const synthPromise = fetch("/api/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed }),
      signal,
    })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error("Speech synthesis failed"))))
      .catch((err) => {
        if (!signal.aborted) console.error("TTS failed for sentence:", trimmed, err);
        return null;
      });
    enqueueSpeechFromPromise(synthPromise, signal);
  };

  // Eva's/the delegate's real answer is full quality, unmodified — written
  // to be read, not heard. Rather than asking the agent to self-limit
  // (unreliable), condense it down to a short spoken summary via a fast,
  // single-purpose model after the fact, streaming that summary into TTS
  // sentence-by-sentence as it's generated (rather than waiting for the
  // whole 2-3 sentence summary) so speech starts a little sooner. Falls
  // back to speaking the original full answer if condensing fails before
  // anything was spoken, so a hiccup here never means silence.
  const speakCondensed = async (text: string, signal: AbortSignal) => {
    const trimmed = text.trim();
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (wordCount <= CONDENSE_SKIP_WORD_COUNT) {
      setStatus("speaking");
      enqueueSpeech(trimmed, signal);
      return;
    }

    let anySpoken = false;
    const chunker = createSentenceChunker((sentence) => {
      if (signal.aborted) return;
      anySpoken = true;
      setStatus("speaking");
      enqueueSpeech(sentence, signal);
    });

    try {
      await streamCondense(trimmed, (delta) => chunker.push(delta), signal);
      chunker.flush();
    } catch (err) {
      if (signal.aborted) return;
      console.error("Condense streaming failed, speaking full answer:", err);
      if (!anySpoken) {
        setStatus("speaking");
        enqueueSpeech(trimmed, signal);
      }
    }
  };

  const processTurn = async (blob: Blob, ext: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    speechChainRef.current = Promise.resolve();

    try {
      setStatus("transcribing");
      const form = new FormData();
      form.append("audio", blob, `recording.${ext}`);
      const sttRes = await fetch("/api/voice/stt", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const sttData = await sttRes.json();
      if (!sttRes.ok) throw new Error(sttData?.error || "Transcription failed");

      const transcript = typeof sttData.text === "string" ? sttData.text.trim() : "";
      if (!transcript) {
        setStatus("idle");
        return;
      }

      setStatus("thinking");

      const answer = await askEva(transcript);

      if (answer.trim() && !controller.signal.aborted) {
        await speakCondensed(answer, controller.signal);
      }

      await speechChainRef.current;
      if (!controller.signal.aborted) setStatus("idle");
    } catch (err) {
      if (controller.signal.aborted) return;
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong");
      setStatus("error");
    }
  };

  const startRecording = async () => {
    setErrorMessage(null);
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
  // next thing. Every async step in processTurn/speech playback already
  // checks this same AbortController's signal, so aborting here is enough
  // to stop future TTS/playback from starting — we only need to
  // explicitly stop audio that's *already* playing, since pausing doesn't
  // happen automatically just because the signal was aborted.
  const interrupt = () => {
    abortRef.current?.abort();

    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.src = "";
    }
    revokeObjectUrl();
    speechChainRef.current = Promise.resolve();

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

    // pause() doesn't fire 'ended', so an in-flight playBlob() promise for
    // the currently-playing sentence is left unresolved here — harmless
    // since ChatInput unmounts this component via onClose() right after.
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.src = "";
    }
    revokeObjectUrl();

    onClose();
  };

  useEffect(() => {
    return () => {
      if (!closedRef.current) {
        abortRef.current?.abort();
        recorderRef.current?.stop();
        micStreamRef.current?.getTracks().forEach((t) => t.stop());
        revokeObjectUrl();
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
      <audio ref={audioElRef} />

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
