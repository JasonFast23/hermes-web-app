# Changelog

What actually shipped, one entry per version.

## 1.0.16 — 2026-09-03

- Delegating to a specialist no longer switches you onto their tab — you stay wherever you were (a banner shows who's working, with a "View" link if you want to watch), so it can't be mistaken for still talking to Eva and accidentally stopped mid-task.
- Fixed Eva not actually having a specialist's findings to relay or email after a delegation reported back — she was only getting a short excerpt of the report, not the whole thing, which is why she'd sometimes ask you to paste the numbers back to her instead of just using them.
- You can now send Eva another message while she's still working on the last one — it queues and sends the moment she's free, instead of the input blocking with Stop as the only option.
- Added file upload — attach a PDF, Excel, or CSV to a message to Eva and she reads real figures out of it instead of guessing.
- Fixed a message getting silently cut short when it ended with a colon and Enter was pressed to start a new line — Enter sends the message; Shift+Enter is what makes a new line, now hinted in the input.
- The Chats list no longer reshuffles every time you open a session — only actual new activity (a message sent or received) moves it to the top.
- Added a Feedback tab — post a bug or concern right in the app instead of emailing it over; it syncs across devices, and marking one fixed clears it with one click.
- The Email and Research agents' tabs no longer accept typing directly — since you're meant to deal with Eva, not them, their input is replaced with a one-tap "Go to Eva" instead.

## 1.0.15 — 2026-08-28

- Fixed the Approve/Decline buttons on a delegation card becoming unreachable when Eva hands off a long task (e.g. a long email body) during a voice session — the task text had no height limit, so a long one pushed the buttons off-screen with nothing scrollable to reach them. The task/purpose text is now capped and scrolls internally instead.

## 1.0.14 — 2026-08-28

- Fixed the dictation button being laggy on Android — the same screen-timeout network throttling that voice mode was fixed for (1.0.9) was never applied to dictation, since it has its own separate audio pipeline. Both now share one wake-lock helper, so any future audio feature gets this protection automatically instead of needing to remember it.

## 1.0.13 — 2026-08-24

- Eva can now place a real phone call on your behalf — ask her to call a number for a stated purpose, approve it, and she actually dials out through the Retell line.
- Added in-app notifications (bell icon, top bar) — when a call needs Priscilla's follow-up, a toast pops up and links straight to that call's transcript in the Phone tab, with the note highlighted.
- Fixed the call transcript screen's "Back" button sitting under the status bar on Android, making it barely tappable.
- Hid the Phone tab's test-call tools for now.

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
