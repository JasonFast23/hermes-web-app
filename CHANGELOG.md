# Changelog

What actually shipped, one entry per version.

## 1.0.34 — 2026-09-16
- Fixed a rare case where pressing a phone menu button could get silently
  dropped mid-call. Button presses now send immediately instead of waiting.

## 1.0.33 — 2026-09-16
- Reverted the silent-skip fix from 1.0.32 — it caused Retell to read
  "NO_RESPONSE_NEEDED" out loud on a real call. Eva replies to every menu
  turn again for now.

## 1.0.32 — 2026-09-16
- Eva now says the answer out loud before ending a call, even if she
  heard it from an automated recording rather than a person.

## 1.0.31 — 2026-09-16
- Fixed Eva thinking a phone menu repeated itself — a pause mid-recording
  was confusing her into replying twice to one announcement. She now
  waits for the whole menu before responding.

## 1.0.30 — 2026-09-16
- Fixed Eva giving up on a phone menu without pressing anything, even
  after being told to try. She's now reminded every turn until she's
  made at least one attempt.

## 1.0.29 — 2026-09-16
- Added a red dot on the About button when a new update is available.

## 1.0.28 — 2026-09-16
- Eva can now actually press buttons and hang up on a call — she used to
  just say she would, without it happening. Calls are also capped at
  6 minutes, and a call stuck repeating itself now ends automatically.
- Fixed Eva giving up on an automated menu without trying an option —
  she now picks the closest match and presses it.

## 1.0.27 — 2026-09-16
- Fixed a file attached to a message sometimes disappearing before Eva
  or another agent could see it.

## 1.0.26 — 2026-09-15
- Fixed a chat jumping back to the bottom while you were scrolled up
  reading something. It now only follows along if you were already
  near the bottom.

## 1.0.25 — 2026-09-15
- Fixed calls being answered by the wrong assistant due to a
  misconfigured shared server route.
- Fixed a two-step request ("look this up, then call about it")
  stopping after the first step.

## 1.0.24 — 2026-09-15
- Fixed a phone batch failing to call the same number twice at once.
  Calls to the same number now run one after another.

## 1.0.23 — 2026-09-15
- Stop now actually cancels a running phone batch instead of doing
  nothing until it times out.

## 1.0.22 — 2026-09-15
- Phone calls redesigned: one approval can now cover a whole list of
  calls, run three at a time, with results (including recordings)
  reported back to Eva automatically.

## 1.0.21 — 2026-09-15
- Fixed Research citing outdated or wrong numbers from a cached page
  instead of the live source.

## 1.0.20 — 2026-09-15
- Fixed delegated tasks losing most of a long report in transit.
- Research now has to quote its source's exact wording for any number
  it cites, and can attach a screenshot as proof.
- Eva no longer re-forwards a request she's already declined.

## 1.0.19 — 2026-09-15
- Fixed attached files not reaching Email or Research when Eva
  delegated a task to them.

## 1.0.18 — 2026-09-15
- Removed Eva's ability to delegate phone calls (a dedicated calling
  flow is planned separately).
- Fixed raw delegation syntax sometimes leaking into chat.
- Fixed Eva sometimes misreading a passing mention of a phone call as
  a direct instruction to call.

## 1.0.17 — 2026-09-12
- Fixed delegation messages getting cut down to one line in transit.
- Email now sees other agents' findings automatically.
- The Email and Research tabs accept direct typing again.