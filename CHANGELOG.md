# Changelog

All notable changes to this app are logged here, one entry per deployed version, so it's easy to see what actually shipped without digging through git history.

## 1.0.5 — 2026-08-20

- **Thinking indicator**: replaced the subtle single blinking cursor with a clearer three-dot bouncing animation while the assistant is generating a reply with no tool call yet.
- **Thinking indicator during tool calls**: the dots now stay visible through every gap in a turn — before the first tool call, between tool calls, and after the last one while the final answer is being written — instead of disappearing the moment any tool call starts and never returning.
- **Microphone/speaker selection**: added an input/output audio device picker (in the volume popover, top-right) so a wrong default mic no longer silently breaks voice mode or dictation. Persisted across reloads, with automatic fallback to the system default if the chosen device disappears.
- **Research mode reliability**: Eva can no longer trigger deep research on her own initiative when delegating — delegation always runs fast. The Fast/Deep toggle on the Research tab now defaults to Fast on every new chat and session switch (previously it silently defaulted to Deep on every reload, which was the actual cause of Fast/Deep "getting mixed up").
- **New session** now always opens on the Eva (Manager) tab, regardless of which tab was last active.
