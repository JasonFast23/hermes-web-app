// Independent of the browser's own (one-way, irreversible-from-JS)
// Notification.permission grant — this is an in-app mute toggle so the
// bell button in TopBar can actually turn pushes off and back on again
// after permission has already been granted.
const MUTE_KEY = "hermes-notifications-muted";

export function isNotificationsMuted(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(MUTE_KEY) === "1";
}

export function setNotificationsMuted(muted: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
}

export interface ToastPayload {
  title: string;
  body?: string;
  // Present when this toast is about a specific phone call (see
  // app/api/phone/webhook/route.ts) — clicking the toast jumps straight to
  // that call's detail in the Phone tab instead of just dismissing it.
  callId?: string;
}

// In-process fan-out so same-tab callers can raise a toast directly,
// without a round trip through /api/notify — that endpoint is for pushes
// originating outside this process (e.g. the phone bridge's webhook
// relay). NotificationListener is the only subscriber today, but nothing
// here assumes that.
const toastListeners = new Set<(toast: ToastPayload) => void>();

export function pushToast(toast: ToastPayload) {
  if (isNotificationsMuted()) return;
  toastListeners.forEach((listener) => listener(toast));
}

export function subscribeToasts(listener: (toast: ToastPayload) => void): () => void {
  toastListeners.add(listener);
  return () => toastListeners.delete(listener);
}
