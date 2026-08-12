"use client";

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/lib/store";
import { SpeakerIcon, SpeakerMutedIcon } from "./Icons";

export function TopBar() {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const voiceVolume = useChatStore((s) => s.voiceVolume);
  const setVoiceVolume = useChatStore((s) => s.setVoiceVolume);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  return (
    <header className="flex h-14 shrink-0 items-center justify-end border-b border-black/[0.06] px-4">
      <div className="relative flex items-center gap-1 text-zinc-500" ref={popoverRef}>
        <button
          type="button"
          aria-label="Voice volume"
          onClick={() => setOpen((o) => !o)}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-black/[0.04]"
        >
          {voiceVolume === 0 ? (
            <SpeakerMutedIcon className="h-[18px] w-[18px]" />
          ) : (
            <SpeakerIcon className="h-[18px] w-[18px]" />
          )}
        </button>

        {open && (
          <div className="absolute right-0 top-10 z-10 w-48 rounded-xl border border-black/[0.06] bg-white p-3 shadow-lg">
            <div className="mb-2 flex items-center justify-between text-[12px] font-medium text-zinc-500">
              <span>Eva&rsquo;s voice</span>
              <span>{Math.round(voiceVolume * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(voiceVolume * 100)}
              onChange={(e) => setVoiceVolume(Number(e.target.value) / 100)}
              className="w-full accent-zinc-900"
              aria-label="Voice volume level"
            />
          </div>
        )}
      </div>
    </header>
  );
}
