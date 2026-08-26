"use client";

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/lib/store";
import { listAudioDevices } from "@/lib/audioDevices";
import { formatPhoneNumber } from "./PhoneView";
import { MenuIcon, PlusIcon, SpeakerIcon, SpeakerMutedIcon, BellIcon, BellOffIcon } from "./Icons";
import { isNotificationsMuted, setNotificationsMuted } from "@/lib/notifications";

// Chrome/Edge only — not in TS's lib.dom types, absent on Safari/Firefox.
// The speaker picker only makes sense to show where it can actually do
// anything (see applyAudioOutput in lib/audioDevices.ts).
const SUPPORTS_OUTPUT_SELECTION =
  typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

// A notice, here, is a call Eva flagged as needing Priscilla's follow-up
// (call_analysis.custom_analysis_data.priscilla_follow_up — see PhoneView)
// — this is the same signal that already drives the toast in
// NotificationListener, just kept around as a persistent list instead of
// fading after 5 seconds. "Unread" is tracked separately from the mute
// toggle below (which only controls whether new toasts pop up); opening
// this dropdown is what actually clears the badge.
function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const setView = useChatStore((s) => s.setView);
  const setPendingPhoneCallToOpen = useChatStore((s) => s.setPendingPhoneCallToOpen);
  const phoneCalls = useChatStore((s) => s.phoneCalls);
  const fetchPhoneCalls = useChatStore((s) => s.fetchPhoneCalls);
  const seenFollowUpCallIds = useChatStore((s) => s.seenFollowUpCallIds);
  const markFollowUpsSeen = useChatStore((s) => s.markFollowUpsSeen);

  useEffect(() => {
    // One-time read of the persisted mute flag on mount — deferred to an
    // effect (rather than a lazy useState initializer) so the client's
    // first render matches the server's SSR output and avoids a hydration
    // mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMuted(isNotificationsMuted());
    // Fetches (or reuses PhoneView's cache — see fetchPhoneCalls) so the
    // badge is accurate without needing the Phone tab to have been opened
    // first, and doubles as a warm-up: by the time someone does open that
    // tab, the list is usually already cached.
    fetchPhoneCalls();
  }, [fetchPhoneCalls]);

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

  const followUps = (phoneCalls ?? []).filter((c) => c.call_analysis?.custom_analysis_data?.priscilla_follow_up);
  const unreadCount = followUps.filter((c) => !seenFollowUpCallIds.includes(c.call_id)).length;

  const toggleOpen = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next && followUps.length > 0) markFollowUpsSeen(followUps.map((c) => c.call_id));
      return next;
    });
  };

  const toggleMute = () => {
    const next = !muted;
    setNotificationsMuted(next);
    setMuted(next);
  };

  const openCall = (callId: string) => {
    setView("phone");
    setPendingPhoneCallToOpen(callId);
    setOpen(false);
  };

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        aria-label={unreadCount > 0 ? `${unreadCount} unread call notice${unreadCount === 1 ? "" : "s"}` : "Call notices"}
        title="Call notices"
        onClick={toggleOpen}
        className="relative flex h-10 w-10 items-center justify-center rounded-md hover:bg-black/[0.04]"
      >
        <BellIcon className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-10 w-80 rounded-xl border border-black/[0.06] bg-white shadow-lg">
          <div className="max-h-80 overflow-y-auto p-2">
            {followUps.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12.5px] text-zinc-400">No call notices yet.</p>
            ) : (
              followUps.map((call) => {
                const counterpart = call.direction === "inbound" ? call.from_number : call.to_number;
                return (
                  <button
                    key={call.call_id}
                    type="button"
                    onClick={() => openCall(call.call_id)}
                    className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-black/[0.04]"
                  >
                    <span className="text-[12.5px] font-medium text-zinc-800">{formatPhoneNumber(counterpart)}</span>
                    <span className="line-clamp-2 text-[12px] text-zinc-500">
                      {call.call_analysis?.custom_analysis_data?.priscilla_follow_up}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="flex items-center justify-between border-t border-black/[0.06] px-3 py-2">
            <span className="text-[12px] text-zinc-500">Notifications</span>
            <button
              type="button"
              onClick={toggleMute}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-zinc-600 hover:bg-black/[0.04]"
            >
              {muted ? <BellOffIcon className="h-3.5 w-3.5" /> : <BellIcon className="h-3.5 w-3.5" />}
              {muted ? "Off" : "On"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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
    <header className="flex min-h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center justify-between border-b border-black/[0.06] px-2 pt-[env(safe-area-inset-top)] md:justify-end md:px-4">
      <button
        type="button"
        aria-label="Open menu"
        onClick={() => setMobileSidebarOpen(true)}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-black/[0.04] md:hidden"
      >
        <MenuIcon className="h-5 w-5" />
      </button>

      <span className="truncate text-[15px] font-medium text-zinc-700 md:hidden">Eva</span>

      <div className="relative flex items-center gap-1 text-zinc-500" ref={popoverRef}>
        <button
          type="button"
          aria-label="New session"
          title="New session"
          onClick={() => startNewSession()}
          className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-black/[0.04] md:hidden"
        >
          <PlusIcon className="h-5 w-5" />
        </button>

        <NotificationBell />

        <button
          type="button"
          aria-label="Voice settings"
          onClick={() => setOpen((o) => !o)}
          className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-black/[0.04]"
        >
          {voiceVolume === 0 ? (
            <SpeakerMutedIcon className="h-5 w-5" />
          ) : (
            <SpeakerIcon className="h-5 w-5" />
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
