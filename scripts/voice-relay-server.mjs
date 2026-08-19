#!/usr/bin/env node
// Standalone WebSocket relay for real-time voice TTS — deliberately NOT part
// of the Next.js app itself. Next.js's request model (even in standalone
// output) doesn't hold a persistent connection the way this needs to; every
// other Hermes backend in this system (jarvis/email/research) is already its
// own small service on its own port, so this follows the same shape instead
// of fighting Next.js for something it isn't built for.
//
// Why this exists: the REST /api/voice/tts route (still used as a fallback
// nowhere else in the app now) synthesizes one full sentence per HTTP call,
// so the *next* sentence can't even start generating audio until the model
// has finished writing that whole sentence. This relay instead keeps one
// persistent connection to ElevenLabs' streaming endpoint per voice turn and
// forwards raw text deltas to it as Eva's answer is still being generated —
// no sentence boundary, no per-call connection overhead, and ElevenLabs
// itself decides how much text to accumulate before producing audio (see
// CHUNK_LENGTH_SCHEDULE below), continuing the same running audio generation
// instead of stitching together independently-synthesized clips.
//
// Protocol this relay speaks to the browser (one connection per voice turn):
//   browser -> relay : {"type":"text","text":"..."}   (raw Eva text deltas)
//   browser -> relay : {"type":"end"}                 (Eva's reply is fully generated)
//   relay -> browser : {"type":"audio","audio":"<base64 pcm_24000 mono 16-bit LE>"}
//   relay -> browser : {"type":"done"}                (final audio chunk sent)
//   relay -> browser : {"type":"error","message":"..."}
//
// The browser never sees the ElevenLabs API key — this process holds it
// server-side and is the only thing that talks to ElevenLabs directly, same
// security boundary as the REST route it's replacing.

import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.VOICE_RELAY_PORT) || 8646;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const MODEL_ID = "eleven_flash_v2_5";
// pcm_24000: raw 16-bit signed little-endian mono samples at 24kHz — chosen
// specifically to avoid MP3 frame-boundary issues when the browser has to
// stitch together audio chunks that were generated independently of any
// frame alignment. Raw PCM has no such alignment concept, so every chunk is
// trivially safe to decode and schedule back-to-back regardless of size.
const OUTPUT_FORMAT = "pcm_24000";
const SAMPLE_RATE = 24000;
// Lower than ElevenLabs' own default ([120,160,250,290]) — our answers are
// tuned to be short (VOICE_MODE_CONTEXT in lib/store.ts), so waiting for 120
// characters before the first chunk of audio is a meaningful chunk of a
// whole short answer. 50 is the documented minimum per chunk.
const CHUNK_LENGTH_SCHEDULE = [50, 90, 120, 150];

if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
  console.error("voice-relay: missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID in the environment");
  process.exit(1);
}

const upstreamUrl =
  `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input` +
  `?model_id=${MODEL_ID}&output_format=${OUTPUT_FORMAT}`;

const wss = new WebSocketServer({ port: PORT });
console.log(`voice-relay: listening on ws://0.0.0.0:${PORT}`);

wss.on("connection", (client) => {
  let upstream = null;
  let upstreamOpen = false;
  let completedNormally = false;
  // Text that arrived before the upstream connection finished its own
  // handshake — flushed in order once it's ready, so a fast-talking client
  // never loses the first words of Eva's reply.
  const pendingText = [];
  let closed = false;

  const closeAll = () => {
    if (closed) return;
    closed = true;
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close();
    if (client.readyState === WebSocket.OPEN) client.close();
  };

  const sendToClient = (payload) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
  };

  try {
    upstream = new WebSocket(upstreamUrl, { headers: { "xi-api-key": ELEVENLABS_API_KEY } });
  } catch {
    sendToClient({ type: "error", message: "Failed to reach ElevenLabs" });
    closeAll();
    return;
  }

  upstream.on("open", () => {
    upstreamOpen = true;
    upstream.send(
      JSON.stringify({
        text: " ",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 },
        generation_config: { chunk_length_schedule: CHUNK_LENGTH_SCHEDULE },
      })
    );
    for (const text of pendingText.splice(0)) {
      upstream.send(JSON.stringify({ text }));
    }
  });

  let loggedFirstChunk = false;

  upstream.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof msg.audio === "string") {
      // Diagnostic: confirm the returned audio is actually raw PCM and not
      // silently MP3 despite requesting output_format=pcm_24000 — there's
      // a documented history of ElevenLabs' WS endpoint doing exactly that.
      // MP3 frames start with a sync word: byte 0 = 0xFF, byte 1's top 3
      // bits all set (0xE0..0xFF). Real 16-bit PCM has no such constraint,
      // so seeing that pattern here would confirm the mismatch directly
      // instead of inferring it from playback symptoms.
      if (!loggedFirstChunk) {
        loggedFirstChunk = true;
        const bytes = Buffer.from(msg.audio, "base64");
        const looksLikeMp3 = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
        console.log(
          `voice-relay: first audio chunk — ${bytes.length} bytes, first 8: ${bytes.subarray(0, 8).toString("hex")}` +
            (looksLikeMp3 ? " — LOOKS LIKE MP3, NOT RAW PCM" : " — looks like raw PCM, as requested")
        );
      }
      sendToClient({ type: "audio", audio: msg.audio, sampleRate: SAMPLE_RATE });
    }
    if (msg.isFinal) {
      completedNormally = true;
      sendToClient({ type: "done" });
      closeAll();
    }
  });

  upstream.on("error", (err) => {
    console.error("voice-relay: upstream ElevenLabs error:", err.message);
    sendToClient({ type: "error", message: "Speech synthesis failed" });
    closeAll();
  });

  // ElevenLabs can reject a connection (bad key, bad voice id, rate limit,
  // etc.) by completing the WS handshake and then closing with a non-1000
  // code instead of ever emitting 'error' — confirmed by testing against
  // the real endpoint with a bad key, which closes 1008 "Invalid API key"
  // here rather than failing the handshake outright. Surface that reason
  // to the client instead of just going silent.
  upstream.on("close", (code, reason) => {
    if (!completedNormally && code !== 1000) {
      const detail = reason?.toString() || `code ${code}`;
      console.error(`voice-relay: upstream closed unexpectedly: ${detail}`);
      sendToClient({ type: "error", message: "Speech synthesis failed" });
    }
    closeAll();
  });

  client.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "text" && typeof msg.text === "string" && msg.text) {
      // ElevenLabs requires each text message to end with a single space.
      const text = msg.text.endsWith(" ") ? msg.text : `${msg.text} `;
      if (upstreamOpen) upstream.send(JSON.stringify({ text }));
      else pendingText.push(text);
    } else if (msg.type === "end") {
      const flush = () => upstream.send(JSON.stringify({ text: "", flush: true }));
      if (upstreamOpen) flush();
      else {
        // Nothing was ever said this turn — still need to flush so
        // ElevenLabs reports isFinal and we can close out cleanly.
        upstream.once("open", flush);
      }
    }
  });

  client.on("close", () => closeAll());
  client.on("error", () => closeAll());
});
