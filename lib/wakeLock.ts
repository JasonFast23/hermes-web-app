// Shared by every feature that streams audio over the network (voice mode,
// dictation): Android suspends/throttles network activity for a
// backgrounded or screen-locked WebView, which turns an ordinarily
// sub-second STT/TTS request into an 18+ second one the moment the screen
// times out mid-session — see CHANGELOG 1.0.9, which first hit this in
// voice mode. Desktop browsers don't get throttled this way, so this only
// matters on Android. Any new audio-streaming feature should call
// holdScreenAwake() when its session starts and release() when it ends, or
// it'll silently regress into the same lag.
export interface AudioWakeLock {
  release: () => void;
}

export function holdScreenAwake(): AudioWakeLock {
  if (!("wakeLock" in navigator)) return { release: () => {} };

  let lock: WakeLockSentinel | null = null;
  let released = false;

  const acquire = async () => {
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      if (released) {
        void sentinel.release();
        return;
      }
      lock = sentinel;
    } catch {
      // Denied/unsupported in this context — the session still works, just
      // without screen-timeout protection.
    }
  };

  void acquire();

  // The Wake Lock API auto-releases whenever the tab/app actually goes to
  // the background (switching apps, screen off via power button) — that's
  // by design and fine, since there's nothing to keep alive for once the
  // user has genuinely left. Re-acquire if they come back mid-session
  // instead of leaving the rest of the session unprotected.
  const handleVisibility = () => {
    if (document.visibilityState === "visible" && !released && !lock) void acquire();
  };
  document.addEventListener("visibilitychange", handleVisibility);

  return {
    release: () => {
      if (released) return;
      released = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      void lock?.release();
      lock = null;
    },
  };
}
