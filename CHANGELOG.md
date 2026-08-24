# Changelog

What actually shipped, one entry per version.

## 1.0.12 — 2026-08-24

- Fixed the Phone tab having no way back to the main screen — it was built as a separate page with no sidebar at all, so neither the sidebar navigation nor the mobile menu worked from there. Phone is now a view within the same app shell, like Chats already was, so the sidebar (and a normal tap back to Eva) is always there.

## 1.0.11 — 2026-08-24

- Fixed the phone's hardware/gesture back button not closing a call's detail view in the Phone tab — it worked with the on-screen "← Back" link but not the device's own back navigation, since opening a call wasn't registered as a real step in browser history.

## 1.0.10 — 2026-08-24

- The Phone tab is now a real call history — every inbound and outbound call on the Retell number, with its AI-generated summary, playable recording, and full transcript. The old browser-mic call simulator still exists, just tucked under a "Test tools" toggle instead of being the whole page.

## 1.0.9 — 2026-08-24

- Fixed voice mode being dramatically slower on Android than on Mac/Windows — the screen locking mid-conversation was letting the phone throttle network activity; voice mode now keeps the screen awake for as long as it's actually in use.

## 1.0.8 — 2026-08-24

- Added a real Android app — install it directly on your phone, backed by the same always-on server this web app runs on.
- Redesigned the phone-width layout: hamburger menu with a slide-out sidebar, mobile header, and a chat view that actually fits a phone screen instead of the desktop sidebar squeezed down.
- Added a "Phone (test)" page for trying the Retell phone-call integration from a browser mic, no real phone number needed.

## 1.0.7 — 2026-08-20

- Eva's delegation no longer adds extra scope beyond what you actually asked.
- Fixed a crash that silently broke every message send when the app was opened in a plain browser instead of through the Electron app.
- Chats search now matches every keyword independently, not just the exact phrase — and always jumps to the actual matching message, even when the chat's title happens to match too.
- Fixed the search-result highlight disappearing instantly instead of fading, and removed extra spacing it was adding around highlighted words.
- Redesigned the Chats search bar — bigger, always visible, no longer hidden behind a small icon.

## 1.0.6 — 2026-08-20

- Answers now stream in at a steady pace instead of dumping in bursts.
- Bolding now highlights just the key fact in a reply, not the whole sentence.
- Research shares findings as it goes instead of going quiet until the end.
- Multi-source research runs faster by checking sources in parallel.
- Fixed Eva sometimes missing the final answer when relaying research.
- Added this About panel to track version history.

## 1.0.5 — 2026-08-20

- Clearer "thinking" animation while waiting for a reply.
- That animation now stays visible during tool calls too, not just before.
- Added a mic/speaker picker so voice mode isn't stuck on the wrong device.
- Fixed Fast/Deep research mode randomly switching on its own.
- New session now always starts on Eva's tab.
