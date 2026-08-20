// Device labels are blank until the browser has granted mic permission at
// least once in this origin — callers enumerate after their own getUserMedia
// call (or after this one) rather than needing their own separate prompt.
export async function listAudioDevices(): Promise<{
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: devices.filter((d) => d.kind === "audioinput"),
    outputs: devices.filter((d) => d.kind === "audiooutput"),
  };
}

// getUserMedia rejects outright if asked for a specific deviceId that has
// since disappeared (unplugged headset, etc.) — falling back to the system
// default instead of failing the whole mic request, which would otherwise
// surface as a confusing "microphone access denied" error for a device
// that was never denied, just gone.
export async function getUserMediaWithFallback(preferredInputId: string | null): Promise<MediaStream> {
  if (preferredInputId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: preferredInputId } },
      });
    } catch {
      // Fall through to the default device below.
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: true });
}

// setSinkId is Chrome/Edge-only (not in TS's lib.dom types, not on
// Safari/Firefox) — feature-detected and best-effort. Silently a no-op
// everywhere else, so callers don't need their own browser check.
export async function applyAudioOutput(el: HTMLMediaElement | null, deviceId: string | null): Promise<void> {
  if (!el || !deviceId) return;
  const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof withSink.setSinkId !== "function") return;
  try {
    await withSink.setSinkId(deviceId);
  } catch {
    // Device may have disappeared, or the browser refused — playback just
    // stays on whatever output it already had.
  }
}
