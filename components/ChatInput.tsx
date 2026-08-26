"use client";

import { useEffect, useRef, useState, FormEvent } from "react";
import { useChatStore } from "@/lib/store";
import { startRealtimeDictation, type RealtimeDictationSession } from "@/lib/realtimeDictation";
import { ArrowUpIcon, MicIcon, StopIcon, WaveformIcon } from "./Icons";
import { VoiceSession } from "./VoiceSession";

type DictationStatus = "idle" | "recording" | "transcribing" | "error";

export function ChatInput() {
  const [text, setText] = useState("");
  const [dictationStatus, setDictationStatus] = useState<DictationStatus>("idle");
  const [dictationError, setDictationError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Text that existed before dictation started — every partial/committed
  // transcript update is computed fresh from this, never from a setText
  // functional updater (which would concatenate each new partial onto the
  // previous one instead of replacing it, since by then `prev` already
  // contains the last partial).
  const baseTextRef = useRef("");
  const sessionRef = useRef<RealtimeDictationSession | null>(null);
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

  const startDictation = async () => {
    setDictationError(null);
    baseTextRef.current = text;
    try {
      sessionRef.current = await startRealtimeDictation(audioInputDeviceId, {
        onPartial: (partial) => {
          const base = baseTextRef.current.trim();
          setText(base ? `${base} ${partial}` : partial);
        },
        onCommitted: (committed) => {
          const base = baseTextRef.current.trim();
          const merged = base ? `${base} ${committed}` : committed;
          baseTextRef.current = merged;
          setText(merged);
        },
        onError: (message) => {
          setDictationError(message);
          setDictationStatus("error");
        },
      });
      setDictationStatus("recording");
    } catch (err) {
      console.error("[dictation] startDictation threw:", err);
      setDictationError(err instanceof Error ? err.message : "Microphone access denied");
      setDictationStatus("error");
    }
  };

  const stopDictation = async () => {
    setDictationStatus("transcribing");
    await sessionRef.current?.stop();
    sessionRef.current = null;
    setDictationStatus("idle");
  };

  const handleMicClick = () => {
    if (dictationStatus === "recording") {
      void stopDictation();
    } else if (dictationStatus !== "transcribing") {
      void startDictation();
    }
  };

  useEffect(() => {
    return () => {
      void sessionRef.current?.stop();
    };
  }, []);

  // Grow the textarea to fit its content (up to the CSS max-height, where
  // it starts scrolling instead) rather than staying a fixed height and
  // scrolling internally the whole time. Coalesced onto a single rAF per
  // frame rather than running synchronously on every `text` change — live
  // dictation partials can update `text` several times a second, and each
  // one forces a synchronous layout reflow (set height:auto, then
  // immediately read scrollHeight) if done eagerly, which is what made
  // dictation feel sticky/janky rather than smooth.
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
              // Live partial transcripts overwrite `text` every ~100-300ms
              // while recording — read-only (not disabled, which would
              // fight focus) keeps it visible/selectable without a
              // keystroke silently losing a race with the next partial.
              readOnly={dictationStatus === "recording"}
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
