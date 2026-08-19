"use client";

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/lib/store";
import { pickRecorderMimeType, extForMimeType } from "@/lib/audio";
import { voiceAudioLevelRef } from "@/lib/voiceAudioLevel";
import { XIcon } from "./Icons";

type Status =
  | "connecting"
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

const SENTENCE_BOUNDARY = /[.!?]+[)"'”]?(?:\s+|$)/;
const MAX_BUFFER = 220;

// ElevenLabs audibly emphasizes markdown emphasis markers — wrapping a
// word in ** genuinely changes its spoken tone/stress, confirmed by ear,
// not just leaving literal asterisks in the audio. Telling the model not
// to use markdown isn't reliable enough on its own (her own text-chat
// prompt tells her to bold the direct answer, and that instruction wins
// out here often enough to matter), so this is stripped unconditionally
// before anything reaches TTS, regardless of what she actually wrote.
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "");
}

// Buffers Eva's own streamed reply and emits complete sentences as
// they're detected, so TTS can start on the first sentence while she's
// still generating the rest — this is the only place that used to also
// buffer a second "condense" pass's output; there's just one LLM call
// now (see VOICE_MODE_CONTEXT in lib/store.ts), so this chunks her real
// generation directly.
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
  // The last sentence handed to TTS, for previous_text continuity (see
  // enqueueSpeech). Updated synchronously in generation order — sentences
  // can synthesize concurrently (only playback is serialized), so this
  // must be set at hand-off time, not when a fetch happens to resolve.
  const previousSpokenTextRef = useRef("");
  // --- Audio-reactive visual (see lib/voiceAudioLevel.ts) --------------
  // Taps the <audio> element's actual output via a Web Audio analyser so
  // the orb in ChatPanel can pulse with real volume, not a fake/synthetic
  // animation. createMediaElementSource can only ever be called once per
  // element for its whole lifetime, hence the guard in ensureAnalyser.
  const levelAudioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const levelRafRef = useRef<number | null>(null);

  const ensureAnalyser = () => {
    if (analyserRef.current || !audioElRef.current) return;
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(audioElRef.current);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6; // smooths frame-to-frame jitter into a nicer pulse
      source.connect(analyser);
      // Required — routing the element through a MediaElementAudioSourceNode
      // hands Web Audio control of its output; skipping this makes it silent.
      analyser.connect(ctx.destination);
      levelAudioContextRef.current = ctx;
      analyserRef.current = analyser;
      // Explicit ArrayBuffer (not the inferred ArrayBufferLike) — recent
      // DOM typings want getByteTimeDomainData's argument backed by a real
      // ArrayBuffer specifically.
      levelDataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    } catch {
      // Web Audio unavailable/blocked — visual flair only, never let this
      // affect actual playback, which doesn't depend on any of this.
    }
  };

  const startLevelLoop = () => {
    const analyser = analyserRef.current;
    const data = levelDataRef.current;
    if (!analyser || !data || levelRafRef.current) return;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      // RMS of the waveform. Unsigned 8-bit time-domain samples sit at 128
      // when silent, so distance from 128 is the actual signal.
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const centered = (data[i] - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      voiceAudioLevelRef.current = Math.min(1, rms * 4); // raw RMS reads low — scaled up for a visible pulse
      levelRafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  const stopLevelLoop = () => {
    if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current);
    levelRafRef.current = null;
    voiceAudioLevelRef.current = 0;
  };
  // ----------------------------------------------------------------------
  // --- Timing diagnostics ---------------------------------------------
  // Temporary instrumentation to find out exactly where the perceived
  // "gap between sentences" comes from: LLM generation, the TTS round
  // trip, or genuine dead air where playback caught up to synthesis.
  // turnStartRef is t=0 for a turn (set the moment the recorded clip is
  // handed off, i.e. right after the user stops talking). lastPlaybackEndRef
  // is when the previous clip's audio actually finished playing, so the
  // "GAP" log is a direct measurement of the silence you're hearing, not
  // an inference. Remove once the diagnosis is confirmed.
  const turnStartRef = useRef(0);
  const sentenceIndexRef = useRef(0);
  const lastPlaybackEndRef = useRef(0);
  const mark = (label: string, extra?: Record<string, unknown>) => {
    const elapsed = Math.round(performance.now() - turnStartRef.current);
    console.log(`[voice +${elapsed}ms] ${label}`, extra ?? "");
  };
  // ----------------------------------------------------------------------
  const askEva = useChatStore((s) => s.askEva);
  const approveDelegation = useChatStore((s) => s.approveDelegation);
  const setVoiceApproveDelegation = useChatStore((s) => s.setVoiceApproveDelegation);
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

  const playBlob = (blob: Blob, signal: AbortSignal, index: number): Promise<void> =>
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
        mark(`audio[${index}]: ended`);
        lastPlaybackEndRef.current = performance.now();
        resolve();
      };
      audioEl.onended = cleanup;
      audioEl.onerror = cleanup;
      if (lastPlaybackEndRef.current > 0) {
        const gapMs = Math.round(performance.now() - lastPlaybackEndRef.current);
        mark(`audio[${index}]: GAP since previous sentence ended = ${gapMs}ms`);
      }
      mark(`audio[${index}]: play() called`);
      audioEl.play().catch(cleanup);
    });

  const enqueueSpeechFromPromise = (blobPromise: Promise<Blob | null>, signal: AbortSignal, index: number) => {
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
      await playBlob(blob, signal, index);
    });
  };

  const enqueueSpeech = (text: string, signal: AbortSignal) => {
    const trimmed = stripMarkdownForSpeech(text).trim();
    if (!trimmed || signal.aborted) return;
    const index = sentenceIndexRef.current++;
    const previousText = previousSpokenTextRef.current;
    previousSpokenTextRef.current = trimmed;
    mark(`tts[${index}]: request start`, { text: trimmed.slice(0, 60) });
    const synthPromise = fetch("/api/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed, previousText }),
      signal,
    })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error("Speech synthesis failed"))))
      .then((result) => {
        mark(`tts[${index}]: blob ready`);
        return result;
      })
      .catch((err) => {
        if (!signal.aborted) console.error("TTS failed for sentence:", trimmed, err);
        return null;
      });
    enqueueSpeechFromPromise(synthPromise, signal, index);
  };

  // Eva's own reply is a single streamed call now (VOICE_MODE_CONTEXT in
  // lib/store.ts shapes her to write conversationally in the first place)
  // — this just chunks that stream into sentences and speaks each one as
  // it arrives, no separate condense pass.
  //
  // The one thing that must never be spoken is a raw [[DELEGATE:...]]
  // marker: when she's handing off to Research/Email, her entire reply
  // (per her base prompt) IS that marker line and nothing else, so there
  // is genuinely nothing to say for that turn — the Approve/Decline card
  // covers it visually. "[[DELEGATE:".length characters are buffered
  // before anything is committed to speech, just enough to tell the two
  // cases apart with no meaningful added latency.
  const DELEGATE_PREFIX = "[[DELEGATE:";

  const speakStreamed = (signal: AbortSignal) => {
    let sniff = "";
    let resolved = false;
    let isDelegating = false;
    let firstDeltaSeen = false;

    const chunker = createSentenceChunker((sentence) => {
      if (signal.aborted) return;
      mark("sentence detected", { text: sentence.slice(0, 60) });
      setStatus("speaking");
      startLevelLoop();
      enqueueSpeech(sentence, signal);
    });

    const onDelta = (delta: string) => {
      if (!firstDeltaSeen) {
        firstDeltaSeen = true;
        mark("llm: first delta received");
      }
      if (resolved) {
        if (!isDelegating) chunker.push(delta);
        return;
      }
      sniff += delta;
      // Compared against a leading-whitespace-trimmed view of what's
      // arrived so far, not the raw buffer — a lone leading space or
      // newline before the marker (a plausible, benign streaming
      // artifact) would otherwise fail the very first character of the
      // prefix check and permanently resolve "not delegating" before the
      // real marker text ever arrived, which is exactly what let a raw
      // [[DELEGATE:...]] line slip through and get spoken. `sniff` itself
      // (untrimmed) is still what's pushed to speech once resolved
      // not-delegating, so no real leading whitespace is ever lost.
      const probe = sniff.trimStart();
      if (probe.length === 0) return; // nothing but whitespace so far — keep buffering
      // Streamed chunks aren't guaranteed to arrive one character at a
      // time — a single delta can easily carry the whole marker line (or
      // a whole ordinary sentence) at once, so the "still ambiguous"
      // check only makes sense while probe is still shorter than the
      // prefix. Once it's at least as long, decide for real by checking
      // probe itself, not the other way around (DELEGATE_PREFIX.startsWith
      // (probe) silently stops being meaningful past that point, since a
      // short string can never "start with" a longer one).
      if (probe.length < DELEGATE_PREFIX.length) {
        if (DELEGATE_PREFIX.startsWith(probe)) return; // still ambiguous — need more
        resolved = true;
        isDelegating = false;
        chunker.push(sniff);
        return;
      }
      resolved = true;
      isDelegating = probe.startsWith(DELEGATE_PREFIX);
      if (!isDelegating) chunker.push(sniff);
    };

    return { onDelta, flush: () => chunker.flush() };
  };

  const processTurn = async (blob: Blob, ext: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    speechChainRef.current = Promise.resolve();
    previousSpokenTextRef.current = "";
    turnStartRef.current = performance.now();
    sentenceIndexRef.current = 0;
    lastPlaybackEndRef.current = 0;
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

      const { onDelta, flush } = speakStreamed(controller.signal);
      await askEva(transcript, undefined, onDelta);
      mark("llm: askEva call resolved (full text done generating)");
      flush();

      await speechChainRef.current;
      stopLevelLoop();
      mark("turn done (all audio finished playing)");
      if (!controller.signal.aborted) setStatus("idle");
    } catch (err) {
      if (controller.signal.aborted) return;
      stopLevelLoop();
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong");
      setStatus("error");
    }
  };

  // Mirrors the tail of processTurn (turn-state reset, speakStreamed,
  // await playback, idle) but for the Approve click on a delegation Eva
  // proposed mid-voice-session: PendingDelegationCard.tsx has no access to
  // this component's speech pipeline, so it calls this via the store's
  // voiceApproveDelegation (registered below) instead of the plain
  // approveDelegation action, which only ever updated text state.
  const speakDelegationResult = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    speechChainRef.current = Promise.resolve();
    previousSpokenTextRef.current = "";
    turnStartRef.current = performance.now();
    sentenceIndexRef.current = 0;
    lastPlaybackEndRef.current = 0;
    mark("delegation approved (voice)");

    try {
      setStatus("thinking");
      const { onDelta, flush } = speakStreamed(controller.signal);
      await approveDelegation(onDelta);
      flush();
      await speechChainRef.current;
      stopLevelLoop();
      mark("delegation relay done (all audio finished playing)");
      if (!controller.signal.aborted) setStatus("idle");
    } catch (err) {
      if (controller.signal.aborted) return;
      stopLevelLoop();
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong");
      setStatus("error");
    }
  };

  useEffect(() => {
    setVoiceApproveDelegation(speakDelegationResult);
    return () => setVoiceApproveDelegation(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRecording = async () => {
    setErrorMessage(null);
    // Tied to this same click's call stack (before any await) so the
    // browser treats AudioContext creation as user-gesture-initiated.
    ensureAnalyser();
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
    stopLevelLoop();

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
    stopLevelLoop();
    levelAudioContextRef.current?.close().catch(() => {});
    levelAudioContextRef.current = null;

    onClose();
  };

  useEffect(() => {
    return () => {
      if (!closedRef.current) {
        abortRef.current?.abort();
        recorderRef.current?.stop();
        micStreamRef.current?.getTracks().forEach((t) => t.stop());
        revokeObjectUrl();
        stopLevelLoop();
        levelAudioContextRef.current?.close().catch(() => {});
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
