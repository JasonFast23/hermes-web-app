"use client";

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/lib/store";
import { listAudioDevices } from "@/lib/audioDevices";
import { MenuIcon, PlusIcon, SpeakerIcon, SpeakerMutedIcon } from "./Icons";

// Chrome/Edge only — not in TS's lib.dom types, absent on Safari/Firefox.
// The speaker picker only makes sense to show where it can actually do
// anything (see applyAudioOutput in lib/audioDevices.ts).
const SUPPORTS_OUTPUT_SELECTION =
  typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

export function TopBar() {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const voiceVolume = useChatStore((s) => s.voiceVolume);
  const setVoiceVolume = useChatStore((s) => s.setVoiceVolume);
  const audioInputDeviceId = useChatStore((s) => s.audioInputDeviceId);
  const setAudioInputDeviceId = useChatStore((s) => s.setAudioInputDeviceId);
  const audioOutputDeviceId = useChatStore((s) => s.audioOutputDeviceId);
  const setAudioOutputDeviceId = useChatStore((s) => s.setAudioOutputDeviceId);
  const setMobileSidebarOpen = useChatStore((s) => s.setMobileSidebarOpen);
  const startNewSession = useChatStore((s) => s.startNewSession);

  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);

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

  // Device labels are blank without an active/prior mic grant — request it
  // once when the panel opens (not on page load, so this doesn't surprise
  // anyone who's never touched voice/dictation yet) so the dropdowns show
  // real device names instead of "Microphone 1".
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        // Permission denied or no mic — still enumerate below; labels will
        // just be blank, same as any other unlabeled-device fallback.
      }
      if (cancelled) return;
      const { inputs, outputs } = await listAudioDevices();
      if (cancelled) return;
      setInputs(inputs);
      setOutputs(outputs);
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-black/[0.06] px-2 pt-[env(safe-area-inset-top)] md:justify-end md:px-4">
      <button
        type="button"
        aria-label="Open menu"
        onClick={() => setMobileSidebarOpen(true)}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-black/[0.04] md:hidden"
      >
        <MenuIcon className="h-[19px] w-[19px]" />
      </button>

      <span className="truncate text-[15px] font-medium text-zinc-700 md:hidden">Eva</span>

      <div className="relative flex items-center gap-1 text-zinc-500" ref={popoverRef}>
        <button
          type="button"
          aria-label="New session"
          title="New session"
          onClick={() => startNewSession()}
          className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-black/[0.04] md:hidden"
        >
          <PlusIcon className="h-[18px] w-[18px]" />
        </button>

        <button
          type="button"
          aria-label="Voice settings"
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
          <div className="absolute right-0 top-10 z-10 w-64 rounded-xl border border-black/[0.06] bg-white p-3 shadow-lg">
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

            <div className="mt-3 border-t border-black/[0.06] pt-3">
              <label className="mb-1 block text-[12px] font-medium text-zinc-500">Microphone</label>
              <select
                value={audioInputDeviceId ?? ""}
                onChange={(e) => setAudioInputDeviceId(e.target.value || null)}
                className="w-full truncate rounded-lg border border-black/[0.08] bg-white px-2 py-1.5 text-[12.5px] text-zinc-700"
              >
                <option value="">System default</option>
                {inputs.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Microphone ${i + 1}`}
                  </option>
                ))}
              </select>
            </div>

            {SUPPORTS_OUTPUT_SELECTION && (
              <div className="mt-3">
                <label className="mb-1 block text-[12px] font-medium text-zinc-500">Speaker</label>
                <select
                  value={audioOutputDeviceId ?? ""}
                  onChange={(e) => setAudioOutputDeviceId(e.target.value || null)}
                  className="w-full truncate rounded-lg border border-black/[0.08] bg-white px-2 py-1.5 text-[12.5px] text-zinc-700"
                >
                  <option value="">System default</option>
                  {outputs.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Speaker ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
