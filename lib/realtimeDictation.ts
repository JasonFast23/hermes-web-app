// Client-side pipeline for the dictation button (components/ChatInput.tsx):
// mic -> resampled 16kHz PCM -> ElevenLabs Scribe v2 Realtime over a direct
// WebSocket -> partial/committed transcript callbacks. Audio never passes
// through our own server — only a short-lived token does (see
// app/api/voice/stt-realtime-token/route.ts) — so this connects straight to
// wss://api.elevenlabs.io.
//
// Separate from components/VoiceSession.tsx's full voice-conversation mode,
// which keeps its existing MediaRecorder + Groq Whisper + ElevenLabs TTS
// pipeline untouched (lib/audio.ts's pickRecorderMimeType/extForMimeType are
// still used there, not here).
import { getUserMediaWithFallback } from "./audioDevices";

// Runs inside the AudioWorkletGlobalScope, not this module's scope — loaded
// via a Blob URL so no separate static asset is needed. Buffers ~40ms of
// native-rate samples before handing off to the main thread (per-128-sample
// render-quantum postMessage/WebSocket-send would be ~125/sec, wasteful and
// a plausible rate-limit target). Only resamples when the context's actual
// sampleRate isn't already 16000 — Android WebView is the runtime least
// likely to honor the AudioContext constructor's requested rate.
const WORKLET_SOURCE = `
class PcmDownsamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._bufferedSamples = 0;
    this._flushThreshold = Math.round(sampleRate * 0.04);
    this._lpAccum = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    this._buffer.push(input.slice());
    this._bufferedSamples += input.length;
    if (this._bufferedSamples >= this._flushThreshold) this._flush();
    return true;
  }

  _flush() {
    const merged = new Float32Array(this._bufferedSamples);
    let offset = 0;
    for (const chunk of this._buffer) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this._buffer = [];
    this._bufferedSamples = 0;

    const pcm16 = this._toPcm16(merged);
    this.port.postMessage(pcm16, [pcm16.buffer]);
  }

  _toPcm16(float32) {
    const targetRate = 16000;
    let samples = float32;
    if (sampleRate !== targetRate) {
      // Single-pole low-pass (cheap anti-aliasing) before linear-
      // interpolation decimation — without it, high-frequency content
      // (sibilants like /s//f/) folds back into the audible band as
      // noise, which matters for STT accuracy more than for the ear.
      const alpha = targetRate / sampleRate;
      const filtered = new Float32Array(float32.length);
      let acc = this._lpAccum;
      for (let i = 0; i < float32.length; i++) {
        acc += alpha * (float32[i] - acc);
        filtered[i] = acc;
      }
      this._lpAccum = acc;

      const ratio = sampleRate / targetRate;
      const outLength = Math.floor(float32.length / ratio);
      samples = new Float32Array(outLength);
      for (let i = 0; i < outLength; i++) {
        const srcIndex = i * ratio;
        const i0 = Math.floor(srcIndex);
        const i1 = Math.min(i0 + 1, filtered.length - 1);
        const frac = srcIndex - i0;
        samples[i] = filtered[i0] + (filtered[i1] - filtered[i0]) * frac;
      }
    }
    const int16 = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
  }
}
registerProcessor("pcm-downsampler", PcmDownsamplerProcessor);
`;

export interface RealtimeDictationHandlers {
  onPartial: (text: string) => void;
  onCommitted: (text: string) => void;
  onError: (message: string) => void;
}

export interface RealtimeDictationSession {
  // Resolves only after the trailing words since the last VAD commit have
  // been flushed and folded in via onCommitted, and the socket/mic are
  // closed — never just closes immediately (see module comment above).
  stop: () => Promise<void>;
}

// Chunked to avoid call-stack limits on String.fromCharCode(...bytes) for
// larger buffers.
function base64FromInt16(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Temporary diagnostic instrumentation — added to pin down a reported
// Android-only "tap mic, speak, nothing happens" failure that produced no
// JS-visible error and no console output, only ambiguous low-level
// Chromium/AAudio activity in logcat. Prefixed so it's trivially greppable
// (`adb logcat | grep dictation`) and easy to remove once the platform gap
// is confirmed. Mirrors how a previous, unrelated real-time-audio bug in
// this codebase (the reverted WebSocket TTS streaming attempt) was
// diagnosed — see git history on components/VoiceSession.tsx.
function log(...args: unknown[]) {
  console.log("[dictation]", ...args);
}
function logError(...args: unknown[]) {
  console.error("[dictation]", ...args);
}

export async function startRealtimeDictation(
  preferredInputId: string | null,
  handlers: RealtimeDictationHandlers
): Promise<RealtimeDictationSession> {
  log("starting");
  const audioContext = new AudioContext({ sampleRate: 16000 });
  log("AudioContext created, requested 16000Hz, actual sampleRate =", audioContext.sampleRate, "state =", audioContext.state);

  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
  const workletReady = audioContext.audioWorklet
    .addModule(workletUrl)
    .then(() => log("worklet module loaded"))
    .catch((err) => {
      logError("worklet module failed to load:", err);
      throw err;
    })
    .finally(() => {
      URL.revokeObjectURL(workletUrl);
    });

  const [, stream, tokenRes] = await Promise.all([
    workletReady,
    getUserMediaWithFallback(preferredInputId).then((s) => {
      log(
        "getUserMedia resolved, tracks:",
        s.getAudioTracks().map((t) => ({ label: t.label, readyState: t.readyState, settings: t.getSettings() }))
      );
      return s;
    }),
    fetch("/api/voice/stt-realtime-token", { method: "POST" }).then((r) => {
      log("token fetch responded, ok =", r.ok, "status =", r.status);
      return r;
    }),
  ]);

  if (!tokenRes.ok) {
    logError("token fetch failed, status =", tokenRes.status);
    stream.getTracks().forEach((t) => t.stop());
    await audioContext.close();
    throw new Error("Failed to start dictation");
  }
  const tokenData: { token?: string } = await tokenRes.json();
  if (!tokenData.token) {
    logError("token response missing token field");
    stream.getTracks().forEach((t) => t.stop());
    await audioContext.close();
    throw new Error("Failed to start dictation");
  }
  log("token minted");

  const params = new URLSearchParams({
    token: tokenData.token,
    model_id: "scribe_v2_realtime",
    audio_format: "pcm_16000",
    commit_strategy: "vad",
    no_verbatim: "true",
    language_code: "en",
    // ElevenLabs' own default is 1.5s of silence before a phrase commits
    // (confirmed via session_started's echoed config) — with normal
    // conversational pauses shorter than that, text sits in the
    // constantly-revising "partial" state for long stretches, which reads
    // as sticky rather than smooth. Committing sooner means text visibly
    // settles more often.
    vad_silence_threshold_secs: "0.5",
  });
  log("opening websocket");
  const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`);

  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, "pcm-downsampler");
  worklet.onprocessorerror = (err) => logError("worklet processor errored:", err);

  let sessionReady = false;
  let stopping = false;
  let stopResolve: (() => void) | null = null;
  let flushTimeout: ReturnType<typeof setTimeout> | null = null;
  let chunksSent = 0;

  const cleanup = () => {
    log("cleanup, chunksSent =", chunksSent);
    try {
      source.disconnect();
    } catch {
      // already disconnected
    }
    try {
      worklet.disconnect();
    } catch {
      // already disconnected
    }
    stream.getTracks().forEach((t) => t.stop());
    void audioContext.close();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  };

  const finishStop = () => {
    if (flushTimeout) clearTimeout(flushTimeout);
    cleanup();
    stopResolve?.();
    stopResolve = null;
  };

  worklet.port.onmessage = (e: MessageEvent<Int16Array>) => {
    if (!sessionReady || ws.readyState !== WebSocket.OPEN) return;
    chunksSent += 1;
    if (chunksSent === 1) log("sending first audio chunk, samples =", e.data.length);
    ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: base64FromInt16(e.data),
        sample_rate: 16000,
        commit: stopping,
      })
    );
  };

  ws.onopen = () => log("websocket open");

  ws.onmessage = (e: MessageEvent<string>) => {
    let data: { message_type?: string; text?: string; message?: string };
    try {
      data = JSON.parse(e.data);
    } catch (err) {
      logError("failed to parse WS message:", e.data, err);
      return;
    }
    log("ws message:", data.message_type, data.text ? `text.length=${data.text.length}` : "");
    switch (data.message_type) {
      case "session_started":
        sessionReady = true;
        // Only start streaming once the session is confirmed live.
        source.connect(worklet);
        log("session_started, mic -> worklet connected");
        break;
      case "partial_transcript":
        handlers.onPartial(data.text ?? "");
        break;
      case "committed_transcript":
        handlers.onCommitted(data.text ?? "");
        if (stopping) finishStop();
        break;
      default:
        // ElevenLabs' protocol has more message types than the three above
        // (timestamp/entity variants, ~13 named error types) — route
        // anything unrecognized or error-shaped to onError rather than
        // silently ignoring it, so a real failure doesn't look like a
        // dropped connection.
        if (typeof data.message_type === "string" && data.message_type.includes("error")) {
          logError("ws error message:", data);
          handlers.onError(data.message ?? data.message_type);
        }
    }
  };
  ws.onerror = (err) => {
    logError("websocket error event:", err);
    handlers.onError("Realtime connection failed");
  };
  ws.onclose = (e) => {
    log("websocket closed, code =", e.code, "reason =", e.reason, "wasClean =", e.wasClean, "stopping =", stopping);
    if (!stopping) handlers.onError("Realtime connection closed unexpectedly");
  };

  return {
    stop: () =>
      new Promise<void>((resolve) => {
        log("stop() called, sessionReady =", sessionReady, "wsReadyState =", ws.readyState);
        stopping = true;
        stopResolve = resolve;
        // Safety net: don't hang forever if no committed_transcript ever
        // arrives (e.g. nothing was pending, or the server doesn't respond).
        flushTimeout = setTimeout(finishStop, 1800);
        if (sessionReady && ws.readyState === WebSocket.OPEN) {
          // Forces a flush of whatever's buffered since the last VAD
          // commit — the trailing words of the sentence someone stopped
          // mid-way through are exactly what'd otherwise be lost.
          ws.send(
            JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", sample_rate: 16000, commit: true })
          );
        } else {
          finishStop();
        }
      }),
  };
}
