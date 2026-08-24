# Changelog

What actually shipped, one entry per version.

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
