"use client";

import { useEffect, useRef } from "react";
import { voiceAudioLevelRef } from "@/lib/voiceAudioLevel";

// Renders while a voice session is on Eva's own tab (see ChatPanel) in
// place of the message thread — a circle that visibly pulses with Eva's
// actual speech volume (voiceAudioLevelRef, written by VoiceSession's own
// audio-analysis loop), not a fake/synthetic animation. Applies the level
// straight to the DOM via requestAnimationFrame rather than React state,
// since re-rendering on every animation frame would be wasteful for a
// value nothing else needs to read.
export function VoiceOrb() {
  const coreRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf: number;
    // Eased toward the target level each frame instead of snapping straight
    // to it — real amplitude jitters fast enough that applying it raw looks
    // twitchy rather than like a smooth pulse.
    let smoothed = 0;

    const tick = () => {
      const target = voiceAudioLevelRef.current;
      smoothed += (target - smoothed) * 0.25;

      if (coreRef.current) {
        coreRef.current.style.transform = `scale(${1 + smoothed * 0.35})`;
      }
      if (glowRef.current) {
        glowRef.current.style.transform = `scale(${1 + smoothed * 1.1})`;
        glowRef.current.style.opacity = String(0.15 + smoothed * 0.45);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative flex h-24 w-24 items-center justify-center">
      <div
        ref={glowRef}
        className="absolute inset-0 rounded-full bg-zinc-900/40 blur-xl transition-[opacity] duration-100"
        style={{ opacity: 0.15 }}
      />
      <div
        ref={coreRef}
        className="relative h-16 w-16 rounded-full bg-zinc-900 shadow-[0_8px_24px_rgba(0,0,0,0.18)]"
      />
    </div>
  );
}
