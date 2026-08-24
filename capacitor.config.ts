import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aipx.eva',
  appName: 'AiPX Agent',
  webDir: 'public',
  // The app has no bundled web assets to speak of — it always loads the
  // live, always-on deployment on zorin over Tailscale's HTTPS proxy (see
  // `tailscale serve` on zorin), the same real backend the browser/PWA
  // version talks to. HTTPS (not the bare Tailscale IP) matters here:
  // getUserMedia only works in a secure context, and voice is the whole
  // point of this app.
  server: {
    url: 'https://jarvised-comp.tailc3d081.ts.net',
    cleartext: false,
  },
};

export default config;
