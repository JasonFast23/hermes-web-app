// Client-side pipeline for the dictation button (components/ChatInput.tsx).
// Captures short (~2s) segments via MediaRecorder — the same API already
// proven reliable everywhere else in this app (the original dictation
// button, and components/VoiceSession.tsx's full voice-conversation mode)
// — and transcribes each one via the existing Groq Whisper endpoint
// (app/api/voice/stt/route.ts). No new vendor, no new API key, no
// AudioWorklet, no raw PCM.
//
// Deliberately restarts the recorder for every segment rather than using a
// single MediaRecorder with a `timeslice`: a timeslice's later chunks
// aren't independently-decodable audio files on their own for webm/opus
// (only the very first chunk carries the container's init segment) — since
// each segment here is sent as its own separate request to a stateless
// batch transcription endpoint, it needs to be a complete, valid file on
// its own. A full stop/start cycle per segment gives exactly that.
//
// Trade-off, by design: this updates in ~2-second bursts, not continuously
// — noticeably less smooth than true low-latency streaming (which needs a
// streaming-capable vendor we don't have an account with), but built
// entirely from APIs already proven solid on every platform this app runs
// on, including the Android WebView where an AudioWorklet-based approach
// was crashing the renderer process.
import { pickRecorderMimeType, extForMimeType } from "./audio";
import { getUserMediaWithFallback } from "./audioDevices";

const SEGMENT_MS = 2000;

export interface RealtimeDictationHandlers {
  // Never fires in this implementation — kept in the interface so
  // components/ChatInput.tsx doesn't need to change if a future revision
  // adds real interim results.
  onPartial: (text: string) => void;
  onCommitted: (text: string) => void;
  onError: (message: string) => void;
}

export interface RealtimeDictationSession {
  stop: () => Promise<void>;
}

async function transcribe(blob: Blob, ext: string): Promise<string> {
  const form = new FormData();
  form.append("audio", blob, `recording.${ext}`);
  const res = await fetch("/api/voice/stt", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "Transcription failed");
  return typeof data.text === "string" ? data.text.trim() : "";
}

// Resolves once `rec`'s onstop has actually fired (MediaRecorder.stop() is
// async — the 'stop' event, and whatever data it delivers, arrives on a
// later tick), running whatever onstop handler was already set first.
function stopRecorder(rec: MediaRecorder): Promise<void> {
  return new Promise((resolve) => {
    if (rec.state === "inactive") {
      resolve();
      return;
    }
    const prev = rec.onstop;
    rec.onstop = (ev) => {
      if (typeof prev === "function") prev.call(rec, ev);
      resolve();
    };
    rec.stop();
  });
}

export async function startRealtimeDictation(
  preferredInputId: string | null,
  handlers: RealtimeDictationHandlers
): Promise<RealtimeDictationSession> {
  const stream = await getUserMediaWithFallback(preferredInputId);
  const mimeType = pickRecorderMimeType();

  let stopping = false;
  let recorder: MediaRecorder | null = null;
  let segmentTimer: ReturnType<typeof setTimeout> | null = null;
  // Serializes transcribe() calls so an out-of-order network response can't
  // append a later segment's text before an earlier one's — each segment
  // waits for the previous segment's transcription to resolve first.
  let pending: Promise<void> = Promise.resolve();

  const startSegment = () => {
    if (stopping) return;
    const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorder = rec;
    const chunks: Blob[] = [];

    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    rec.onstop = () => {
      const finalMimeType = rec.mimeType || mimeType;
      const blob = new Blob(chunks, { type: finalMimeType });
      if (blob.size > 0) {
        pending = pending
          .then(() => transcribe(blob, extForMimeType(finalMimeType)))
          .then((text) => {
            if (text) handlers.onCommitted(text);
          })
          .catch((err) => {
            handlers.onError(err instanceof Error ? err.message : "Transcription failed");
          });
      }
      if (!stopping) startSegment();
    };

    rec.start();
    segmentTimer = setTimeout(() => {
      if (recorder === rec && rec.state === "recording") rec.stop();
    }, SEGMENT_MS);
  };

  startSegment();

  return {
    stop: async () => {
      stopping = true;
      if (segmentTimer) clearTimeout(segmentTimer);
      if (recorder) await stopRecorder(recorder);
      // By the time stopRecorder's promise resolves, its onstop handler
      // (above) has already run and chained the final segment's
      // transcribe() call onto `pending` — awaiting it now covers that
      // last segment too, so the trailing words aren't lost.
      await pending;
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
