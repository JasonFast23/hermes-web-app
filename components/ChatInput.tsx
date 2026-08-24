"use client";

import { useEffect, useRef, useState, FormEvent } from "react";
import { useChatStore } from "@/lib/store";
import { pickRecorderMimeType, extForMimeType } from "@/lib/audio";
import { getUserMediaWithFallback } from "@/lib/audioDevices";
import { ArrowUpIcon, MicIcon, StopIcon, WaveformIcon } from "./Icons";
import { VoiceSession } from "./VoiceSession";

type DictationStatus = "idle" | "recording" | "transcribing" | "error";

export function ChatInput() {
  const [text, setText] = useState("");
  const [dictationStatus, setDictationStatus] = useState<DictationStatus>("idle");
  const [dictationError, setDictationError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dictationStreamRef = useRef<MediaStream | null>(null);
  const dictationRecorderRef = useRef<MediaRecorder | null>(null);
  const dictationChunksRef = useRef<Blob[]>([]);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
  const setActiveAgent = useChatStore((s) => s.setActiveAgent);
  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const researchFastMode = useChatStore((s) => s.researchFastMode);
  const setResearchFastMode = useChatStore((s) => s.setResearchFastMode);
  const voiceOpen = useChatStore((s) => s.voiceOpen);
  const setVoiceOpen = useChatStore((s) => s.setVoiceOpen);
  const audioInputDeviceId = useChatStore((s) => s.audioInputDeviceId);

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
    if (isStreaming) return;

    sendMessage(trimmed);
    setText("");
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const transcribeDictation = async (blob: Blob, ext: string) => {
    try {
      const form = new FormData();
      form.append("audio", blob, `recording.${ext}`);
      const res = await fetch("/api/voice/stt", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Transcription failed");

      const transcript = typeof data.text === "string" ? data.text.trim() : "";
      if (transcript) {
        setText((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript));
      }
      setDictationStatus("idle");
    } catch (err) {
      setDictationError(err instanceof Error ? err.message : "Transcription failed");
      setDictationStatus("error");
    }
  };

  const startDictation = async () => {
    setDictationError(null);
    try {
      const stream = await getUserMediaWithFallback(audioInputDeviceId);
      dictationStreamRef.current = stream;

      const mimeType = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      dictationChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) dictationChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        dictationStreamRef.current?.getTracks().forEach((t) => t.stop());
        dictationStreamRef.current = null;

        const blob = new Blob(dictationChunksRef.current, { type: recorder.mimeType || mimeType });
        void transcribeDictation(blob, extForMimeType(recorder.mimeType || mimeType));
      };

      dictationRecorderRef.current = recorder;
      recorder.start();
      setDictationStatus("recording");
    } catch (err) {
      setDictationError(err instanceof Error ? err.message : "Microphone access denied");
      setDictationStatus("error");
    }
  };

  const stopDictation = () => {
    dictationRecorderRef.current?.stop();
    setDictationStatus("transcribing");
  };

  const handleMicClick = () => {
    if (dictationStatus === "recording") {
      stopDictation();
    } else if (dictationStatus !== "transcribing") {
      void startDictation();
    }
  };

  useEffect(() => {
    return () => {
      dictationRecorderRef.current?.stop();
      dictationStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Grow the textarea to fit its content (up to the CSS max-height, where
  // it starts scrolling instead) rather than staying a fixed height and
  // scrolling internally the whole time.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const hasText = text.trim().length > 0;

  return (
    <form
      onSubmit={handleSubmit}
      className="px-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6"
    >
      <div className="mx-auto w-full max-w-2xl">
        {dictationStatus === "error" && dictationError && (
          <p className="mb-2 px-1 text-[12px] text-red-600">{dictationError}</p>
        )}

        {activeAgentId === "graphic" && !voiceOpen && (
          <div className="mb-2 flex justify-end">
            <div
              className="flex items-center gap-0.5 rounded-full border border-black/[0.08] bg-white p-0.5 text-[11.5px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
              title={
                researchFastMode
                  ? "Fast: a quick, single-lookup overview — switch to Deep for the usual multi-source research"
                  : "Deep: the usual thorough multi-source research — switch to Fast for a quick overview"
              }
            >
              <button
                type="button"
                onClick={() => setResearchFastMode(true)}
                aria-pressed={researchFastMode}
                className={`rounded-full px-2.5 py-1 transition-colors ${
                  researchFastMode ? "bg-zinc-900 text-white" : "text-zinc-500 hover:bg-black/[0.04]"
                }`}
              >
                Fast
              </button>
              <button
                type="button"
                onClick={() => setResearchFastMode(false)}
                aria-pressed={!researchFastMode}
                className={`rounded-full px-2.5 py-1 transition-colors ${
                  !researchFastMode ? "bg-zinc-900 text-white" : "text-zinc-500 hover:bg-black/[0.04]"
                }`}
              >
                Deep
              </button>
            </div>
          </div>
        )}

        {voiceOpen ? (
          <VoiceSession onClose={() => setVoiceOpen(false)} />
        ) : (
          <div className="flex items-center gap-2 rounded-3xl border border-black/[0.07] bg-white px-2 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.05)]">
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
                dictationStatus === "recording"
                  ? "Listening…"
                  : dictationStatus === "transcribing"
                    ? "Transcribing…"
                    : ""
              }
              className="max-h-[60vh] flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1.5 text-sm text-zinc-700 outline-none placeholder:text-zinc-400"
            />

            <button
              type="button"
              onClick={handleMicClick}
              disabled={dictationStatus === "transcribing"}
              title={
                dictationStatus === "recording"
                  ? "Stop dictation"
                  : dictationStatus === "transcribing"
                    ? "Transcribing…"
                    : "Dictate"
              }
              aria-label={dictationStatus === "recording" ? "Stop dictation" : "Start dictation"}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
                dictationStatus === "recording"
                  ? "animate-pulse bg-red-500 text-white"
                  : dictationStatus === "transcribing"
                    ? "text-zinc-400 opacity-60"
                    : "text-zinc-500 hover:bg-black/[0.05]"
              }`}
            >
              <MicIcon className="h-[18px] w-[18px]" />
            </button>

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
