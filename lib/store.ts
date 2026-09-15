import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { AGENTS, AgentId, DEFAULT_AGENT_ID, ENABLED_AGENT_IDS } from "./agents";
import { createSyncStorage, subscribeSyncUpdates, registerStreamingCheck, whenSyncReady } from "./syncClientStorage";
import { markDeleted } from "./sync-tombstones";

// Mirrors the shape /api/phone/calls returns (a filtered, summary-only
// slice of Retell's v3 list-calls response) — shared between PhoneView and
// TopBar's notification bell so both read the one cached copy in this
// store instead of each fetching and typing it separately.
export interface CallSummary {
  call_id: string;
  direction?: "inbound" | "outbound" | string;
  from_number?: string;
  to_number?: string;
  start_timestamp?: number;
  duration_ms?: number;
  call_status?: string;
  call_analysis?: {
    call_summary?: string;
    user_sentiment?: string;
    call_successful?: boolean;
    custom_analysis_data?: { priscilla_follow_up?: string };
  };
}

export interface ToolEvent {
  id: string;
  tool: string;
  emoji?: string;
  label?: string;
  status: "running" | "completed";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolEvents?: ToolEvent[];
}

// A file the user uploaded to a session — see /api/files/extract. text is
// the already-server-side-truncated extracted content (CSV per sheet for a
// spreadsheet, plain text for a PDF); truncated flags when MAX_EXTRACT_CHARS
// cut it short, so buildFileContext can say so rather than silently handing
// the model a partial document.
export interface AttachedFile {
  id: string;
  filename: string;
  kind: "pdf" | "spreadsheet";
  text: string;
  truncated: boolean;
  uploadedAt: number;
}

// A note Priscilla posts from the Feedback tab (a bug, a rough edge, a
// request) so it shows up for Jason next time he opens the app — the
// alternative being her emailing him each one separately, which is what
// this replaces. Synced like sessions (see lib/syncClientStorage.ts) so it
// appears on whichever device he's on, not just the one she posted from.
export interface FeedbackItem {
  id: string;
  text: string;
  createdAt: number;
  resolved: boolean;
}

export interface ToolProgressPayload {
  tool: string;
  emoji?: string;
  label?: string;
  toolCallId: string;
  status: string;
}

// Plain-English fallback for known tool slugs, so a user unfamiliar with the
// underlying tool names (e.g. a lawyer, not an engineer) never sees raw
// backend identifiers like "google-workspace" or "web-search" in the chat.
const TOOL_NAME_LABELS: Record<string, string> = {
  browser: "Reading a source page",
  "web-search": "Searching the web",
  web_search: "Searching the web",
  web: "Searching the web",
  "google-workspace": "Checking your inbox",
  google_workspace: "Checking your inbox",
  gmail: "Checking your inbox",
  terminal: "Running a task",
  skills: "Using a skill",
};

function humanizeToolName(tool: string): string {
  return tool
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// The backend's `label` sometimes carries the literal shell invocation it
// ran (e.g. `GAPI="python3 ${HERMES_HOME}/.../google_api.py" + 1 command`)
// or just echoes the tool slug back — both are backend internals, not a
// description meant for a reader, so they're treated the same as no label
// at all rather than displayed verbatim.
const LOOKS_LIKE_CODE = /[$=]|\$\{|\bpython3?\b|\.py\b/i;

export function friendlyToolLabel(event: { tool: string; label?: string }): string {
  const fallback = TOOL_NAME_LABELS[event.tool] ?? humanizeToolName(event.tool);
  if (!event.label) return fallback;
  // A label that's itself a known slug (e.g. the backend echoing "google-
  // workspace" as the label instead of the `tool` field) still deserves the
  // friendly mapping, not a verbatim slug dump.
  if (TOOL_NAME_LABELS[event.label]) return TOOL_NAME_LABELS[event.label];
  if (event.label === event.tool || LOOKS_LIKE_CODE.test(event.label)) return fallback;
  return event.label;
}

// A running log of subagents' final answers per turn, kept separate from
// any agent's visible thread — it exists purely to give Eva awareness of
// what Research/Email/Case File found, without those tabs ever showing it
// and without dumping tool calls or intermediate chatter into her context.
export interface AgentActivityEntry {
  agentId: AgentId;
  summary: string;
  timestamp: number;
}

// Bounds how much of the activity log gets kept (and fed to Eva) so a long
// session doesn't grow this — and the context injected into every one of
// Eva's turns — without limit.
const MAX_AGENT_ACTIVITY_ENTRIES = 15;

// A delegation processDelegateMarker has detected but not yet run — surfaced
// in the UI as an Approve/Decline card instead of firing automatically.
// hopsLeft is carried over from the detecting call so the MAX_DELEGATION_HOPS
// budget is unaffected by the pause.
export interface PendingDelegation {
  sessionId: string;
  fromAgentId: AgentId;
  targetAgentId: AgentId;
  task: string;
  hopsLeft: number;
  onToolEvent?: (event: ToolProgressPayload) => void;
  // Only meaningful when targetAgentId is "graphic" (Research). Undefined
  // is treated the same as "fast" — see DELEGATE_MARKER.
  researchMode?: "fast" | "deep";
}

// A message typed while its target agent was still streaming (or working
// through a delegation), held here instead of being dropped — see
// queueMessage. sessionId/agentId pin it to the tab it was written for so
// it can only ever be sent into that same conversation, never wherever the
// user happens to be navigated to once it's this message's turn.
export interface QueuedMessage {
  id: string;
  sessionId: string;
  agentId: AgentId;
  text: string;
}

// A ChatSession is shared across Eva/Email/Research: one id, used as the
// Hermes session key for all three profiles, so they scope memory/context
// consistently to "this session" — but each still gets its own thread of
// messages, since they're separate Hermes profiles under the hood.
export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  // Bumped whenever the session gets new activity (a message sent or
  // received) — the list sorts by this, not createdAt, so messaging an old
  // session floats it back to the top like any normal chat app. Merely
  // opening/viewing a session does NOT bump this — see switchSession —
  // since reordering the list on every click was disorienting. Optional so
  // sessions persisted before this field existed still load fine; use
  // sessionRecency() below rather than reading this field directly.
  lastActiveAt?: number;
  threads: Partial<Record<AgentId, ChatMessage[]>>;
  agentActivity: AgentActivityEntry[];
  // Files uploaded into this session (Eva's tab only, for now — see
  // attachFile). Optional so sessions persisted before this field existed
  // still load fine.
  attachedFiles?: AttachedFile[];
}

export function sessionRecency(session: ChatSession): number {
  return session.lastActiveAt ?? session.createdAt;
}

interface ChatState {
  activeAgentId: AgentId;
  activeSessionId: string | null;
  sessions: ChatSession[];
  isStreaming: boolean;
  // The in-flight request's controller, if any — lets stopStreaming() cancel
  // whatever's currently running (including mid-delegation) from the UI.
  // Never persisted; it's only meaningful for the live session.
  activeAbortController: AbortController | null;
  // A delegation awaiting Approve/Decline. Never persisted — holds a live
  // callback and only makes sense for the page session that detected it.
  pendingDelegation: PendingDelegation | null;
  // Set for the duration of an approved delegation's actual run (from
  // approveDelegation through the target agent's reply) — unlike
  // pendingDelegation, this doesn't gate an approval, it's just "who's
  // working right now" so the UI can say so without forcing the user's
  // view onto that agent's tab (delegateToAgent used to do that; it read
  // as the app hijacking navigation, and cost one user an accidental stop
  // when they thought they were still on Eva's tab). Never persisted —
  // only meaningful for a live run.
  activeDelegation: { sessionId: string; targetAgentId: AgentId; task: string } | null;
  // Messages submitted while isStreaming was already true for that
  // session/agent — sent automatically once that run finishes (see
  // drainMessageQueue) instead of being blocked with no way to submit
  // them. Never persisted — a reload losing an unsent queued message is
  // an acceptable edge case for state that's only ever seconds old.
  messageQueue: QueuedMessage[];
  // Filenames currently being uploaded to /api/files/extract — lets the
  // input show a "reading…" chip per in-flight upload. Never persisted.
  pendingUploads: string[];
  // Set when a Chats-search result is clicked: which message to scroll to
  // and briefly highlight in the chat panel, and the query that matched it
  // (so the exact matched text, not just the message, can be marked).
  // Never persisted — purely a one-shot navigation hint for ChatPanel.
  scrollToMessage: { messageId: string; query: string } | null;
  error: string | null;
  sidebarCollapsed: boolean;
  // Below the md breakpoint the sidebar isn't a permanent layout column at
  // all (see Sidebar.tsx) — it's an off-canvas drawer toggled by a
  // hamburger button, so it needs its own open/closed flag independent of
  // sidebarCollapsed (which only makes sense for the desktop rail). Never
  // persisted — a phone reload should always land closed.
  mobileSidebarOpen: boolean;
  view: "chat" | "sessions" | "phone" | "feedback";
  // Posted from the Feedback tab. Synced across devices (see
  // lib/syncClientStorage.ts) so Jason sees what Priscilla posts, and vice
  // versa, without either having to be looking at the same device.
  feedbackItems: FeedbackItem[];
  // Set when a notification toast for a specific call is clicked (see
  // NotificationListener) — PhoneView reads and clears this on mount/
  // update to jump straight to that call's detail instead of the list.
  // Never persisted, purely a one-shot navigation hint, same pattern as
  // scrollToMessage below.
  pendingPhoneCallToOpen: string | null;
  // Cached list of real (non-test) phone calls from /api/phone/calls,
  // shared between PhoneView and TopBar's notification bell so whichever
  // one asks first fetches for both — opening the Phone tab after the
  // bell has already loaded it (or vice versa) is instant instead of
  // showing a spinner every time. Persisted so even a cold app start
  // shows the last-known list immediately while fetchPhoneCalls quietly
  // refreshes it in the background.
  phoneCalls: CallSummary[] | null;
  phoneCallsFetchedAt: number | null;
  phoneCallsLoading: boolean;
  phoneCallsError: string | null;
  // call_ids whose Priscilla follow-up notice has already been shown in
  // the bell's dropdown — drives its unread badge count. Persisted so
  // read state survives a reload instead of every follow-up reappearing
  // as unread.
  seenFollowUpCallIds: string[];
  // 0 (silent) to 1 (full) — controls playback volume for Eva's spoken
  // replies in VoiceSession. Persisted like other UI preferences below.
  voiceVolume: number;
  // When true, a direct message to the Research agent asks for a quick,
  // single-answer overview (like a search engine's AI Overview) instead of
  // the thorough multi-source dig. Defaults true and is never persisted —
  // every new chat starts on Fast, and only switches to Deep for messages
  // sent within a session where it was explicitly toggled on. The previous
  // behavior (defaulting to Deep, silently, on every load) was the actual
  // cause of Fast/Deep feeling like it "gets mixed up": toggling to Fast
  // never stuck past a reload, so a chat that looked set to Fast was
  // quietly running Deep again.
  researchFastMode: boolean;
  // Lifted out of ChatInput (rather than local component state) so
  // ChatPanel can also read it — while a voice session is open, the panel
  // shows a plain "listening" view instead of the scrolling message
  // thread, since reading along while also hearing it defeats the point
  // of a voice conversation. Never persisted — a voice session doesn't
  // survive a reload anyway (ChatInput tears down the mic/recorder on
  // unmount).
  voiceOpen: boolean;
  // Preferred mic/speaker, by deviceId — null means "system default".
  // Persisted so a device picked once (e.g. after the exact problem that
  // prompted this: a working mic that wasn't the OS's selected default)
  // stays picked across reloads instead of silently reverting.
  audioInputDeviceId: string | null;
  audioOutputDeviceId: string | null;

  setActiveAgent: (id: AgentId) => void;
  setView: (view: "chat" | "sessions" | "phone" | "feedback") => void;
  postFeedback: (text: string) => void;
  toggleFeedbackResolved: (id: string) => void;
  setResearchFastMode: (fast: boolean) => void;
  setVoiceOpen: (open: boolean) => void;
  startNewSession: () => void;
  switchSession: (sessionId: string) => void;
  openSearchResult: (sessionId: string, agentId: AgentId, messageId: string, query: string) => void;
  clearScrollTarget: () => void;
  deleteSession: (sessionId: string) => void;
  deleteSessions: (sessionIds: string[]) => void;
  sendMessage: (text: string) => Promise<void>;
  // Called instead of sendMessage when isStreaming is already true for the
  // current session/agent — parks the text in messageQueue rather than
  // dropping it. Silently no-ops on an empty session id the way sendMessage
  // itself never has to worry about (it always runs after ensureActiveSession).
  queueMessage: (text: string) => void;
  removeQueuedMessage: (id: string) => void;
  // Uploads a file to /api/files/extract and, on success, adds it to the
  // active session's attachedFiles (creating the session first if needed,
  // same as sendMessage). Failure is surfaced through the existing `error`
  // field rather than a thrown rejection, matching sendMessage's pattern.
  attachFile: (file: File) => Promise<void>;
  removeAttachedFile: (fileId: string) => void;
  delegateToAgent: (
    sessionId: string,
    fromAgentId: AgentId,
    targetAgentId: AgentId,
    task: string,
    onToolEvent?: (event: ToolProgressPayload) => void,
    researchMode?: "fast" | "deep",
    hopsLeft?: number
  ) => Promise<string>;
  askEva: (
    message: string,
    onToolEvent?: (event: ToolProgressPayload) => void,
    onDelta?: (chunk: string) => void
  ) => Promise<string>;
  approveDelegation: (onDelta?: (chunk: string) => void) => Promise<void>;
  declineDelegation: () => void;
  setPendingPhoneCallToOpen: (callId: string | null) => void;
  // Stale-while-revalidate: a no-op if a fetch is already in flight, or if
  // the cache is younger than PHONE_CALLS_STALE_MS and opts.force isn't
  // set — callers don't need to reason about that, just call it on mount.
  fetchPhoneCalls: (opts?: { force?: boolean }) => Promise<void>;
  // Permanently deletes from Retell (no undo — see the [callId] route's
  // DELETE handler), then drops any that succeeded from local state.
  // Throws if every deletion failed, so the caller can surface an error;
  // a partial failure just silently keeps the failed ones in the list.
  deletePhoneCalls: (callIds: string[]) => Promise<void>;
  markFollowUpsSeen: (callIds: string[]) => void;
  toggleSidebar: () => void;
  setMobileSidebarOpen: (open: boolean) => void;
  setVoiceVolume: (volume: number) => void;
  setAudioInputDeviceId: (deviceId: string | null) => void;
  setAudioOutputDeviceId: (deviceId: string | null) => void;
  stopStreaming: () => void;
  // Registered by VoiceSession while a voice session is open (null
  // otherwise) so PendingDelegationCard's Approve button can route Eva's
  // post-delegation reply through the same speech pipeline a normal voice
  // turn uses, instead of silently landing only in her text thread. See
  // the comment on approveDelegation's onDelta param for why this exists.
  voiceApproveDelegation: (() => Promise<void>) | null;
  setVoiceApproveDelegation: (fn: (() => Promise<void>) | null) => void;
}

// Only Eva (jarvis) ever emits a line like "[[DELEGATE:email]] draft a
// reply to..." — she's the sole orchestrator; the subagents she delegates
// to (Email/Research) are pure specialists that report straight back
// rather than delegating onward themselves. Maps the marker keyword to
// the internal AgentId (the Research tab's id is "graphic", not
// "research").
// Case File ("casefile" -> "rag") is commented out for now — product
// focus is email and research alongside Eva. Restore the entry below and
// the "|casefile" alternation to bring it back.
const DELEGATE_TARGETS: Record<string, AgentId> = {
  email: "email",
  research: "graphic",
  // casefile: "rag",
};
// Research delegations may optionally carry a :fast or :deep suffix (e.g.
// "[[DELEGATE:research:deep]]") — see RESEARCH_FAST_MODE_CONTEXT /
// RESEARCH_DEEP_MODE_CONTEXT. No suffix defaults to fast (processDelegateMarker),
// matching "quick answer by default, offer to go deeper" rather than the
// old always-unrestricted delegation behavior.
// Phone is deliberately not a delegate target — Eva can't propose a real
// call at all (see her system prompt); only "email" and "research" ever
// match here.
const DELEGATE_MARKER = /^\[\[DELEGATE:(email|research)(?::(fast|deep))?\]\][ \t]*([\s\S]*)$/m;

// Caps how many delegate -> Eva-reacts -> delegate-again cycles a single
// turn can chain through, so a model that keeps re-delegating can't loop
// forever.
const MAX_DELEGATION_HOPS = 5;

// How long a cached phone-calls list is trusted before fetchPhoneCalls
// treats it as worth re-fetching. Short enough that a call which just
// ended shows up on the next tab visit/bell open without a manual reload,
// long enough that switching between the Phone tab and elsewhere a few
// times in a row doesn't re-hit the API (and, behind it, Retell) every time.
const PHONE_CALLS_STALE_MS = 20_000;

// crypto.randomUUID() only exists in a secure context (HTTPS, or
// localhost). This app is also reachable over plain HTTP on a private
// Tailscale IP — fine for the Electron shell, which explicitly flags that
// origin as secure, but a normal browser hitting the same URL directly
// has no such flag, and crypto.randomUUID is simply undefined there,
// crashing every send. These ids are local React keys/session
// identifiers, not security tokens, so a non-crypto fallback is fine.
function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function createSession(): ChatSession {
  const now = Date.now();
  return {
    id: newId(),
    title: "New session",
    createdAt: now,
    lastActiveAt: now,
    threads: {},
    agentActivity: [],
  };
}

// Only the excerpt below gets resent to Eva on every future turn (see
// buildAgentActivityContext) — full findings stay intact in recordAgentActivity's
// stored entries and in that agent's own tab, just not repeated into
// context indefinitely.
const AGENT_ACTIVITY_EXCERPT_CHARS = 500;

// Formats the session's subagent-activity log into a compact block Eva
// receives as an extra system message — invisible in every tab's UI, but
// gives her a running "what did each agent just find" awareness without
// requiring the user to relay it themselves. Undefined when there's
// nothing to report, so idle sessions don't pay for an empty block.
//
// Deliberately bounded two ways, both found necessary by testing: only
// the most recent entry per agent (not the full history — a long session
// would otherwise accumulate several full findings and resend all of them
// on every future turn), and each one truncated to a short excerpt. A
// full, several-KB finding resent verbatim on every subsequent turn was
// found to make Eva's replies clip short across the board — even for
// questions with nothing to do with that finding, like "explain
// photosynthesis" — not just when she was actually relaying it. The full
// text is never lost: it's still in recordAgentActivity's stored entry
// and, unabridged, in that agent's own tab — Eva is told (see her system
// prompt) to point there for more instead of this block trying to carry
// the whole thing forward forever.
function buildAgentActivityContext(
  session: ChatSession | undefined,
  // Set on the one turn immediately following a delegation report (see
  // runEvaAfterDelegation) so THAT agent's entry is handed over in full
  // instead of the usual excerpt — a mid-table truncation right when Eva
  // is asked to relay specific numbers reads to the model as an
  // incomplete quote, and she'll hedge ("I don't want to make up the
  // amounts") rather than risk it. Fine to do here because it's a single
  // turn, not resent indefinitely — every later turn still excerpts it.
  fullForAgentId?: AgentId,
  // Set by delegateToAgent: unlike Eva's own chat (where this block is
  // resent on every turn, so truncating keeps her replies from clipping
  // short across the board — see AGENT_ACTIVITY_EXCERPT_CHARS), a
  // delegation only injects this ONCE, and the target agent has no other
  // way to see another agent's findings at all. Excerpting there doesn't
  // save anything and silently drops most of a long report (e.g. a
  // 21-town research table) down to whichever towns happened to survive
  // in the last 500 characters — which is exactly why Email was marking
  // towns "CALL ASSESSOR" that Research actually had answers for. A
  // one-time delegation payload should always be the full report.
  full?: boolean
): string | undefined {
  const entries = session?.agentActivity ?? [];
  if (entries.length === 0) return undefined;

  const latestByAgent = new Map<AgentId, AgentActivityEntry>();
  for (const e of entries) latestByAgent.set(e.agentId, e);

  const lines = Array.from(latestByAgent.values()).map((e) => {
    const name = AGENTS[e.agentId].name;
    const isTruncated = !full && e.agentId !== fullForAgentId && e.summary.length > AGENT_ACTIVITY_EXCERPT_CHARS;
    // Keep the TAIL, not the head — Research's reply can now open with a
    // run of brief "found X, checking Y next" notes (see
    // RESEARCH_DEEP_MODE_CONTEXT) before its actual structured answer at
    // the end. Truncating from the front would hand Eva only those
    // in-progress notes and cut off before the real conclusion ever
    // arrives, which is worse than not truncating at all.
    const excerpt = isTruncated ? `…${e.summary.slice(-AGENT_ACTIVITY_EXCERPT_CHARS)}` : e.summary;
    return `${name}: ${excerpt}${isTruncated ? ` [excerpt — full report in the ${name} tab]` : ""}`;
  });

  return (
    "Other agents' most recent findings in this session (for your " +
    "awareness only — the user has not seen this as a message from you, " +
    "so don't refer to it as something you already said). These are " +
    "short excerpts, not the complete reports:\n\n" +
    lines.join("\n\n")
  );
}

// Resent in full on every turn (unlike buildAgentActivityContext's
// per-turn excerpt) — a file the user deliberately attached is usually
// exactly what the conversation is about, not incidental background, so
// truncating it after the first turn would break the common case of a
// follow-up question about a different figure in the same document.
// /api/files/extract already caps each file's own text server-side, so
// this is still bounded per file, just not re-truncated on top of that.
function buildFileContext(session: ChatSession | undefined): string | undefined {
  const files = session?.attachedFiles ?? [];
  if (files.length === 0) return undefined;

  const blocks = files.map(
    (f) =>
      `File: ${f.filename}${f.truncated ? " (truncated — this is only part of the file)" : ""}\n${f.text}`
  );

  return (
    "The user has attached the following file(s) to this conversation. " +
    "Answer from their actual contents — quote or reference specific " +
    "figures directly rather than describing the file in vague terms, " +
    "and don't claim something is or isn't in the file without checking " +
    "the text below:\n\n" +
    blocks.join("\n\n---\n\n")
  );
}

// pendingDelegation now persists across the user's follow-up messages
// (see sendMessage) instead of silently clearing, so without this Eva has
// no way to know a delegation she proposed is still just sitting there
// unapproved — she'd otherwise answer a "did you do it?" from memory of
// having said she'd delegate, confidently claiming it's in progress when
// it never actually ran.
function buildPendingDelegationContext(pending: PendingDelegation | null, sessionId: string): string | undefined {
  if (!pending || pending.sessionId !== sessionId) return undefined;
  // Research and Email can now propose delegating directly to each other
  // (still gated by the same Approve/Decline card), so the proposer isn't
  // always Eva herself — say who it actually was rather than always "you."
  const proposer =
    pending.fromAgentId === "jarvis" ? "You" : `The ${AGENTS[pending.fromAgentId].name}`;
  return (
    `${proposer} proposed delegating to the ${AGENTS[pending.targetAgentId].name} a moment ago ` +
    `("${pending.task}") but the user has not approved or declined it yet — it has NOT ` +
    `run, and nothing has come back from it. Do not say it's done, in progress, or that ` +
    `you're waiting on the agent to report — none of that is true yet. If it's relevant ` +
    `to what the user just asked, tell them plainly you're still waiting on their ` +
    `approval for that one, shown above.`
  );
}

// askEva (the voice pipeline's only caller — no text-UI path uses it).
// This is the entire shaping of what gets spoken: VoiceSession streams
// this call's own text straight into TTS sentence-by-sentence as it
// generates, with no second "condense" pass rewriting it afterward — so
// what she writes here IS what gets said, at generation time, not
// something compressed after the fact. Everything about *what* she
// decides (delegate vs. answer herself, the delegation rules, the marker
// format) is unchanged from her base prompt; this context only overrides
// *how she writes it* for a call instead of a chat message.
const VOICE_MODE_CONTEXT =
  "This is a live spoken phone call, not a chat message — there is no " +
  "screen, nothing written is being displayed anywhere, and no one is " +
  "reading you. Someone listening to speech doesn't have the attention " +
  "span they'd have reading the same thing on a screen — an explanation " +
  "that's fine written out becomes exhausting to just sit and listen " +
  "to, and it starts to feel like it's never going to end. So default " +
  "to brief and direct: the shortest thing that actually answers what " +
  "they asked, usually one sentence, rarely more than two. Lead with " +
  "the answer itself — don't build up to it, don't explain your " +
  "reasoning, don't list caveats unless one genuinely changes the " +
  "answer. Only go longer than that if they explicitly ask for more " +
  "('tell me more', 'explain that') or the request itself can't be done " +
  "any shorter (e.g. reading something back verbatim) — and even then, " +
  "stay as tight as the request allows rather than defaulting back to a " +
  "full explanation. Never use markdown, bullet points, headings, or a " +
  "bolded lead-in — none of that means anything spoken aloud, so just " +
  "say the thing plainly, the way you'd say it out loud to someone in " +
  "the room. If this needs delegating to Research or Email, the marker " +
  "line is still your entire reply exactly as your base instructions " +
  "say — say nothing else in that turn; once it's approved and reported " +
  "back, react to it conversationally like anything else, still brief. " +
  "The user will need to check the app to approve a delegation before " +
  "it actually runs — voice can't approve that for you.";

// Opted into per-message via the Research tab's Fast/Deep toggle. Fast is
// bounded two ways: this prompt caps it at a handful of sources, and
// sendMessage also strips "browser" from the toolsets it's allowed to use
// for the request (see toolsetsOverride below) — rendering a JS-heavy page
// is the slowest thing the agent can do, so Fast can't reach for it at
// all, not just get told not to.
const RESEARCH_FAST_MODE_CONTEXT =
  "For this question, the user wants a fast overview, not your usual " +
  "deep research — think of how a search engine's AI Overview answers: " +
  "a quick search or two is enough. Stop once you've checked roughly " +
  "3-4 sources (fewer is fine if the answer is already clear) — do not " +
  "keep searching to cross-verify beyond that. And the ANSWER ITSELF " +
  "must match that speed: short, plain, natural language — the direct " +
  "answer plus just enough context to make it useful, the way an AI " +
  "Overview reads, not a research brief. Skip exhaustive caveat lists. " +
  "Still ground it in something real and cite that source. If they want " +
  "more depth after this, they'll ask — don't pre-empt that here. If " +
  "this ends up taking more than one search, the moment a search or " +
  "page gives you a real fact or number, state it plainly right then, " +
  "in your normal reply, bolding that specific fact the same way your " +
  "final answer does — 'It shipped **June 9**.' Only write something " +
  "when you actually have a fact to report. Never narrate the process " +
  "itself — not what you're about to search for, not that a source " +
  "looked stale or inconsistent, not that you're cross-checking or re-" +
  "fetching something. That's all invisible, silent work; resolve it " +
  "and report only the fact that comes out the other end. If a search " +
  "or page turns up nothing usable, don't mention that either — just " +
  "move on to the next one. Then still close with the full direct-" +
  "answer format described below, pulling together everything you " +
  "found.";

// The counterpart to RESEARCH_FAST_MODE_CONTEXT, sent when Deep is
// selected — makes the toggle's other state an explicit, deliberate
// choice instead of "Fast has instructions, Deep is just whatever happens
// by default." Deliberately permissive rather than restrictive: no source
// count, no tool restriction (full toolsets, including browser) — the
// agent verifies and cross-references as much as it judges a grounded,
// quality answer actually needs.
const RESEARCH_DEEP_MODE_CONTEXT =
  "For this question, the user specifically wants your full, thorough " +
  "research process — take as many searches, page visits, and cross-" +
  "checks as you judge the question actually needs to be confident in " +
  "a well-grounded answer. There's no source-count cap and no rush; " +
  "verify claims against multiple sources where it matters rather than " +
  "settling for the first result. As you go, the moment a search or " +
  "page gives you a real fact, number, or answer to part of the " +
  "question, state it plainly right then, in your normal reply, " +
  "bolding that specific fact the same way your final answer does — " +
  "'Attendance was **48,000**.' Only write something when you actually " +
  "have a fact to report; this is what lets someone watching see real " +
  "answers surface as you go, not a transcript of your search terms. " +
  "Never narrate the process itself — not what you're about to look " +
  "up, not that a source looked stale, conflicting, or broken, not " +
  "that you're cross-checking or re-fetching something to be sure. All " +
  "of that is invisible, silent work — resolve it yourself and report " +
  "only the fact that comes out the other end, once you actually trust " +
  "it. If a search or page turns up nothing usable, don't mention that " +
  "either — just move on to the next one. Once research is actually " +
  "done, still close with the full direct-answer format described " +
  "below (bolded key fact plus supporting detail), pulling together " +
  "everything you found — the interim answers lead up to that, they " +
  "don't replace it.";

function combineContext(...parts: Array<string | undefined>): string | undefined {
  const joined = parts.filter((p): p is string => !!p).join("\n\n");
  return joined || undefined;
}

function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "New session";
  return trimmed.length > 40 ? trimmed.slice(0, 40) + "…" : trimmed;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function extractDelta(json: unknown): string {
  if (
    typeof json === "object" &&
    json !== null &&
    "choices" in json &&
    Array.isArray((json as { choices: unknown }).choices)
  ) {
    const choice = (json as { choices: Array<Record<string, unknown>> })
      .choices[0];
    const delta = choice?.delta as { content?: string } | undefined;
    if (delta?.content) return delta.content;
  }
  return "";
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

// Stable per (chat session, agent) id, sent as X-Hermes-Session-Id so the
// Hermes backend keeps real conversation continuity — including tool calls
// and their results — in its own state.db. Deterministic from the two
// inputs, so it survives page reloads and resumes exactly where a session
// left off without us tracking anything extra client-side.
function hermesSessionId(sessionId: string, agentId: AgentId): string {
  return `${sessionId}:${agentId}`;
}

async function streamChatCompletion(
  agentId: AgentId,
  sessionKey: string,
  newMessage: HistoryMessage,
  onDelta: (chunk: string) => void,
  onToolEvent?: (event: ToolProgressPayload) => void,
  signal?: AbortSignal,
  context?: string,
  // Narrows which of the agent's own toolsets this one request may use
  // (e.g. dropping "browser" for Research's Fast mode, see
  // RESEARCH_FAST_MODE_CONTEXT) — the route only ever narrows, never
  // widens, so this can't grant a tool the agent isn't already configured
  // for.
  toolsetsOverride?: string[]
): Promise<string> {
  let fullText = "";

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [newMessage],
      agentId,
      hermesSessionId: hermesSessionId(sessionKey, agentId),
      sessionKey,
      context,
      toolsetsOverride,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Request failed with status ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamDone = false;
  // SSE pairs an `event:` line with the `data:` line(s) that follow, until a
  // blank line ends the block. Hermes uses this to send tool-call activity
  // (`event: hermes.tool.progress`) alongside the normal chat completion
  // chunks (unnamed — default "message" event).
  let currentEventType = "message";

  while (!streamDone) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() === "") {
        currentEventType = "message";
        continue;
      }

      if (line.startsWith("event:")) {
        currentEventType = line.slice(6).trim();
        continue;
      }

      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith("data:")) continue;

      const data = trimmedLine.slice(5).trim();

      if (currentEventType === "hermes.tool.progress") {
        try {
          onToolEvent?.(JSON.parse(data) as ToolProgressPayload);
        } catch (err) {
          console.error("Failed to parse tool progress event:", data, err);
        }
        continue;
      }

      if (data === "[DONE]") {
        streamDone = true;
        break;
      }

      try {
        const parsed = JSON.parse(data);
        const delta = extractDelta(parsed);
        if (delta) {
          fullText += delta;
          onDelta(delta);
        }
      } catch (err) {
        console.error("Failed to parse SSE chunk from Hermes:", data, err);
      }
    }
  }

  return fullText;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => {
      const ensureActiveSession = (): ChatSession => {
        const state = get();
        const existing = state.sessions.find((s) => s.id === state.activeSessionId);
        if (existing) return existing;

        const session = createSession();
        set((s) => ({ sessions: [...s.sessions, session], activeSessionId: session.id }));
        return session;
      };

      const appendMessages = (
        sessionId: string,
        agentId: AgentId,
        msgs: ChatMessage[],
        titleSeed?: string
      ) => {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId
              ? {
                  ...sess,
                  title:
                    sess.title === "New session" && titleSeed
                      ? deriveTitle(titleSeed)
                      : sess.title,
                  lastActiveAt: Date.now(),
                  threads: {
                    ...sess.threads,
                    [agentId]: [...(sess.threads[agentId] ?? []), ...msgs],
                  },
                }
              : sess
          ),
        }));
      };

      const appendToMessage = (
        sessionId: string,
        agentId: AgentId,
        messageId: string,
        chunk: string
      ) => {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId
              ? {
                  ...sess,
                  threads: {
                    ...sess.threads,
                    [agentId]: (sess.threads[agentId] ?? []).map((m) =>
                      m.id === messageId ? { ...m, content: m.content + chunk } : m
                    ),
                  },
                }
              : sess
          ),
        }));
      };

      // Logs a subagent's final answer for a turn into the session's
      // activity feed — never called for jarvis itself, since Eva doesn't
      // need a digest of her own replies. Trims to the most recent
      // MAX_AGENT_ACTIVITY_ENTRIES so a long session's context injection
      // stays bounded.
      const recordAgentActivity = (sessionId: string, agentId: AgentId, summary: string) => {
        const trimmed = summary.trim();
        if (agentId === "jarvis" || !trimmed) return;

        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId
              ? {
                  ...sess,
                  agentActivity: [
                    ...(sess.agentActivity ?? []),
                    { agentId, summary: trimmed, timestamp: Date.now() },
                  ].slice(-MAX_AGENT_ACTIVITY_ENTRIES),
                }
              : sess
          ),
        }));
      };

      const updateToolEvent = (
        sessionId: string,
        agentId: AgentId,
        messageId: string,
        event: ToolProgressPayload
      ) => {
        set((s) => ({
          sessions: s.sessions.map((sess) => {
            if (sess.id !== sessionId) return sess;
            return {
              ...sess,
              threads: {
                ...sess.threads,
                [agentId]: (sess.threads[agentId] ?? []).map((m) => {
                  if (m.id !== messageId) return m;
                  const events = m.toolEvents ?? [];
                  const idx = events.findIndex((e) => e.id === event.toolCallId);
                  const status: ToolEvent["status"] = event.status === "completed" ? "completed" : "running";

                  if (idx < 0) {
                    return {
                      ...m,
                      toolEvents: [
                        ...events,
                        { id: event.toolCallId, tool: event.tool, emoji: event.emoji, label: event.label, status },
                      ],
                    };
                  }
                  return {
                    ...m,
                    toolEvents: events.map((e, i) =>
                      i === idx
                        ? { ...e, status, label: event.label ?? e.label, emoji: event.emoji ?? e.emoji }
                        : e
                    ),
                  };
                }),
              },
            };
          }),
        }));
      };

      // Shared by sendMessage/askEva/runEvaAfterDelegation: checks an
      // agent's just-streamed reply for a [[DELEGATE:x]] marker, strips it
      // from the displayed message, then — instead of running the subagent
      // automatically — parks it as a pendingDelegation for the user to
      // Approve/Decline (see approveDelegation). Returns the text available
      // right now (the stripped acknowledgment), not the eventual delegated
      // result, since that no longer resolves synchronously.
      const processDelegateMarker = async (
        sessionId: string,
        agentId: AgentId,
        messageId: string,
        fullText: string,
        onToolEvent: ((event: ToolProgressPayload) => void) | undefined,
        hopsLeft: number
      ): Promise<string> => {
        const match = DELEGATE_MARKER.exec(fullText);
        if (!match) return fullText.trim();

        const rawTask = match[3].trim();
        const strippedText = fullText.replace(DELEGATE_MARKER, "").replace(/^\s+/, "");

        // Takes an explicit override so a marker that can't actually run
        // (hop limit, unknown/self target) can still replace the raw
        // "[[DELEGATE:...]]" syntax in the persisted message with a plain
        // fallback line, instead of leaving the literal marker text
        // sitting in the chat.
        const applyStrip = (text: string = strippedText) =>
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === sessionId
                ? {
                    ...sess,
                    threads: {
                      ...sess.threads,
                      [agentId]: (sess.threads[agentId] ?? []).map((m) =>
                        m.id === messageId ? { ...m, content: text } : m
                      ),
                    },
                  }
                : sess
            ),
          }));

        // A marker was found but can't actually run (hop limit hit, or no
        // task text after it) — strip it either way so the raw
        // "[[DELEGATE:...]]" syntax never sits in the chat unexplained.
        // applyStrip (not just the return value) is what actually updates
        // the displayed message — the return value alone only affects the
        // activity-log excerpt callers log it into.
        if (hopsLeft <= 0 || !rawTask) {
          const fallback = strippedText || fullText.trim();
          applyStrip(fallback);
          return fallback;
        }

        const target = DELEGATE_TARGETS[match[1]];
        // Eva's own delegation never runs deep research — that's reserved
        // for the user's manual Fast/Deep toggle on the Research tab (see
        // researchFastMode below), never something she chooses on their
        // behalf. Ignores match[2] (a stray ":deep" suffix, if the model
        // ever emits one despite the system prompt no longer describing
        // it) rather than trusting it.
        const researchMode = "fast";
        if (!target || target === agentId) {
          const fallback = strippedText || fullText.trim();
          applyStrip(fallback);
          return fallback;
        }

        applyStrip();
        set({
          pendingDelegation: {
            sessionId,
            fromAgentId: agentId,
            targetAgentId: target,
            task: rawTask,
            hopsLeft,
            onToolEvent,
            researchMode,
          },
        });

        return strippedText;
      };

      // Gives Eva (jarvis) a fresh turn after a subagent reports back. The
      // report itself isn't in her visible thread — it reaches her via the
      // activity-log context block (buildAgentActivityContext), same as a
      // direct tab conversation would — so a plain nudge (never shown/
      // persisted, matching how the system prompt itself is invisible) is
      // all that's needed to prompt her actual reaction, since the chat
      // API needs a trailing user-role turn. Recurses through
      // processDelegateMarker (bounded by hopsLeft) so a chain like
      // research -> report -> Eva delegates email keeps working even
      // though the subagents themselves can no longer chain directly.
      const runEvaAfterDelegation = async (
        sessionId: string,
        onToolEvent: ((event: ToolProgressPayload) => void) | undefined,
        hopsLeft: number,
        onDelta?: (chunk: string) => void,
        justReportedAgentId?: AgentId
      ): Promise<string> => {
        const session = get().sessions.find((s) => s.id === sessionId);

        const assistantMessage: ChatMessage = { id: newId(), role: "assistant", content: "" };
        appendMessages(sessionId, "jarvis", [assistantMessage]);

        // Mirrors askEva's appendToAssistant (lib/store.ts, askEva below):
        // onDelta is how a voice session's TTS chunker hears Eva's reply as
        // it streams. Without this forward, her relay of a delegated
        // agent's findings only ever reached appendToMessage — it landed in
        // her text thread but was never spoken, which is why voice mode
        // went silent right after a delegation was approved.
        const appendToAssistant = (chunk: string) => {
          appendToMessage(sessionId, "jarvis", assistantMessage.id, chunk);
          onDelta?.(chunk);
        };
        const handleToolEvent = (event: ToolProgressPayload) => {
          updateToolEvent(sessionId, "jarvis", assistantMessage.id, event);
          onToolEvent?.(event);
        };

        // Eva's actual prior turns live server-side now (X-Hermes-Session-Id
        // continuity) — this is just the new nudge turn, not a history replay.
        // Deliberately doesn't say "the agent YOU delegated to" — Research and
        // Email can now hand off directly to each other (still gated by an
        // Approve/Decline card, same as every delegation), so the report
        // Eva's reacting to might not be one she personally set in motion.
        const nudge: HistoryMessage = {
          role: "user",
          content:
            "An agent has reported back — see the findings noted above " +
            "for your awareness. In almost every case that report " +
            "already answers what the user asked, so just relay/" +
            "summarize it to them now and stop — do not delegate again " +
            "on your own initiative. In particular, if the report " +
            "offers to do more for the USER (e.g. 'if you have a " +
            "different spelling, I can search again'), that offer is " +
            "for the user to accept or decline, not something you act " +
            "on yourself by guessing what they'd say. Only delegate " +
            "again if the user's ORIGINAL request explicitly required a " +
            "further step that genuinely hasn't happened yet. If " +
            "there's a pending delegation noted below still awaiting the " +
            "user's approval — proposed by you or by another agent — " +
            "don't claim it's done or promise it yourself; it's already " +
            "shown to the user as a card they can approve or decline.",
        };

        const controller = new AbortController();
        set({ activeAbortController: controller });

        let fullText: string;
        try {
          fullText = await streamChatCompletion(
            "jarvis",
            sessionId,
            nudge,
            appendToAssistant,
            handleToolEvent,
            controller.signal,
            combineContext(
              buildAgentActivityContext(session, justReportedAgentId),
              buildPendingDelegationContext(get().pendingDelegation, sessionId),
              buildFileContext(session)
            )
          );
        } catch (err) {
          if (isAbortError(err)) {
            appendToAssistant("\n\n_Stopped._");
            return "Stopped.";
          }
          const detail = err instanceof Error ? err.message : "Request failed";
          appendToAssistant(`\n\n⚠️ ${detail}`);
          return `Sorry, I hit an error: ${detail}`;
        } finally {
          set({ activeAbortController: null });
        }

        return processDelegateMarker(sessionId, "jarvis", assistantMessage.id, fullText, onToolEvent, hopsLeft - 1);
      };

      // Called from the finally block of every action that flips
      // isStreaming back to false (sendMessage, approveDelegation) so a
      // message queued mid-run gets sent the moment it's free, with no
      // separate polling or timer needed. Only pulls a
      // queued message that belongs to whatever session/agent is CURRENTLY
      // active — if the user has since navigated elsewhere, it's left
      // queued rather than firing into a tab the user isn't looking at;
      // it'll send next time that tab is active and idle (including
      // immediately, if the user is still there when this runs).
      const drainMessageQueue = () => {
        const state = get();
        if (state.isStreaming) return;
        const idx = state.messageQueue.findIndex(
          (q) => q.sessionId === state.activeSessionId && q.agentId === state.activeAgentId
        );
        if (idx === -1) return;
        const next = state.messageQueue[idx];
        set({ messageQueue: state.messageQueue.filter((_, i) => i !== idx) });
        void get().sendMessage(next.text);
      };

      return {
        activeAgentId: DEFAULT_AGENT_ID,
        activeSessionId: null,
        sessions: [],
        isStreaming: false,
        activeAbortController: null,
        pendingDelegation: null,
        activeDelegation: null,
        messageQueue: [],
        pendingUploads: [],
        scrollToMessage: null,
        error: null,
        sidebarCollapsed: false,
        mobileSidebarOpen: false,
        view: "chat",
        pendingPhoneCallToOpen: null,
        phoneCalls: null,
        phoneCallsFetchedAt: null,
        phoneCallsLoading: false,
        phoneCallsError: null,
        seenFollowUpCallIds: [],
        feedbackItems: [],
        voiceVolume: 1,
        researchFastMode: true,
        voiceOpen: false,
        audioInputDeviceId: null,
        audioOutputDeviceId: null,

        setActiveAgent: (id) => {
          set({ activeAgentId: id, view: "chat" });
          // Catches a message that was queued for this tab while it wasn't
          // the active one and finished streaming in the background —
          // drainMessageQueue only fires automatically from the tab that
          // was active AT the moment streaming ended, so switching here
          // needs its own check too.
          drainMessageQueue();
        },
        setView: (view) => set({ view }),
        postFeedback: (text) => {
          const trimmed = text.trim();
          if (!trimmed) return;
          set((s) => ({
            feedbackItems: [
              { id: newId(), text: trimmed, createdAt: Date.now(), resolved: false },
              ...s.feedbackItems,
            ],
          }));
        },
        toggleFeedbackResolved: (id) =>
          set((s) => ({
            feedbackItems: s.feedbackItems.map((f) =>
              f.id === id ? { ...f, resolved: !f.resolved } : f
            ),
          })),
        setVoiceVolume: (volume) => set({ voiceVolume: Math.min(1, Math.max(0, volume)) }),
        setResearchFastMode: (fast) => set({ researchFastMode: fast }),
        setVoiceOpen: (open) => set({ voiceOpen: open }),
        setAudioInputDeviceId: (deviceId) => set({ audioInputDeviceId: deviceId }),
        setAudioOutputDeviceId: (deviceId) => set({ audioOutputDeviceId: deviceId }),

        startNewSession: () => {
          // Don't create a session record yet — just clear the active
          // selection so the panel shows a blank slate. A real session is
          // only added to the list (via ensureActiveSession) once the user
          // actually sends a first message, matching Claude's "New chat".
          // researchFastMode resets here too (see its own comment) — Deep
          // is only ever something explicitly switched on within a given
          // conversation, never something that should follow you into a
          // new one. activeAgentId resets to Eva so a new chat always
          // starts on the manager tab, not wherever you last happened to
          // be (e.g. left on Research or Email from the previous session).
          set({
            activeSessionId: null,
            activeAgentId: DEFAULT_AGENT_ID,
            view: "chat",
            pendingDelegation: null,
            scrollToMessage: null,
            researchFastMode: true,
          });
        },

        switchSession: (sessionId) => {
          if (!get().sessions.some((s) => s.id === sessionId)) return;
          // A pending approval (or search-result scroll target) belongs to
          // the session that raised it — don't let it linger and fire out
          // of context after switching. Same for researchFastMode: see
          // startNewSession's comment just above.
          // Just opening a session does NOT bump lastActiveAt — only actual
          // new activity in it does (see appendMessages). Reordering the
          // list on open as well made it reshuffle under the user's cursor
          // on every click, which is disorienting when clicking through
          // several sessions in a row.
          set({
            activeSessionId: sessionId,
            view: "chat",
            pendingDelegation: null,
            scrollToMessage: null,
            researchFastMode: true,
          });
          // See setActiveAgent's comment — catches a message queued for
          // this session while it wasn't the active one.
          drainMessageQueue();
        },

        // Used by the Chats search results: jump straight to the session,
        // agent thread, and specific message a keyword matched, instead of
        // just opening the session and leaving the user to hunt for it.
        openSearchResult: (sessionId, agentId, messageId, query) => {
          if (!get().sessions.some((s) => s.id === sessionId)) return;
          // See switchSession's comment — opening a session on its own
          // doesn't reorder the list.
          set({
            activeSessionId: sessionId,
            activeAgentId: agentId,
            view: "chat",
            pendingDelegation: null,
            scrollToMessage: { messageId, query },
          });
        },

        clearScrollTarget: () => set({ scrollToMessage: null }),

        deleteSession: (sessionId) => {
          get().deleteSessions([sessionId]);
        },

        deleteSessions: (sessionIds) => {
          markDeleted(sessionIds);
          const idSet = new Set(sessionIds);
          set((s) => {
            const sessions = s.sessions.filter((sess) => !idSet.has(sess.id));
            if (!s.activeSessionId || !idSet.has(s.activeSessionId)) return { sessions };

            const next = [...sessions].sort((a, b) => sessionRecency(b) - sessionRecency(a))[0];
            return { sessions, activeSessionId: next ? next.id : null };
          });
        },

        deletePhoneCalls: async (callIds) => {
          const results = await Promise.allSettled(
            callIds.map((id) => fetch(`/api/phone/calls/${id}`, { method: "DELETE" }))
          );
          const deletedIds = new Set(
            callIds.filter((_, i) => {
              const r = results[i];
              return r.status === "fulfilled" && r.value.ok;
            })
          );
          if (deletedIds.size > 0) {
            set((s) => ({ phoneCalls: s.phoneCalls?.filter((c) => !deletedIds.has(c.call_id)) ?? null }));
          }
          if (deletedIds.size < callIds.length) {
            const failedCount = callIds.length - deletedIds.size;
            throw new Error(
              deletedIds.size === 0
                ? "Failed to delete call" + (callIds.length > 1 ? "s" : "")
                : `${failedCount} call${failedCount > 1 ? "s" : ""} failed to delete`
            );
          }
        },

        toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
        setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
        setPendingPhoneCallToOpen: (callId) => set({ pendingPhoneCallToOpen: callId }),

        fetchPhoneCalls: async (opts) => {
          const force = opts?.force ?? false;
          const state = get();
          if (state.phoneCallsLoading) return;
          if (!force && state.phoneCallsFetchedAt && Date.now() - state.phoneCallsFetchedAt < PHONE_CALLS_STALE_MS) {
            return;
          }
          set({ phoneCallsLoading: true, phoneCallsError: null });
          try {
            const res = await fetch("/api/phone/calls");
            if (!res.ok) throw new Error("Failed to load call history");
            const data: { calls: CallSummary[] } = await res.json();
            set({ phoneCalls: data.calls, phoneCallsFetchedAt: Date.now(), phoneCallsLoading: false });
          } catch (err) {
            set({
              phoneCallsError: err instanceof Error ? err.message : "Failed to load call history",
              phoneCallsLoading: false,
            });
          }
        },

        markFollowUpsSeen: (callIds) =>
          set((s) => ({ seenFollowUpCallIds: Array.from(new Set([...s.seenFollowUpCallIds, ...callIds])) })),

        // Cancels whatever request is currently in flight — including a
        // delegated hand-off, since only one streamChatCompletion call is
        // ever active at a time and each one registers itself here right
        // before it starts. The fetch's AbortSignal tears down both the
        // request and the in-progress body read, so this stops a stuck/
        // looping agent immediately rather than waiting it out.
        stopStreaming: () => {
          get().activeAbortController?.abort();
        },

        // Runs a delegation processDelegateMarker parked instead of firing
        // automatically. Mirrors exactly what processDelegateMarker used to
        // do inline (delegateToAgent, then give Eva a follow-up turn) — if
        // that follow-up finds another marker, it recurses through
        // processDelegateMarker again, which parks a new pendingDelegation
        // rather than auto-continuing, so a chain still needs one approval
        // per hop.
        approveDelegation: async (onDelta) => {
          const pending = get().pendingDelegation;
          if (!pending) return;
          set({
            pendingDelegation: null,
            isStreaming: true,
            activeDelegation: {
              sessionId: pending.sessionId,
              targetAgentId: pending.targetAgentId,
              task: pending.task,
            },
          });
          try {
            await get().delegateToAgent(
              pending.sessionId,
              pending.fromAgentId,
              pending.targetAgentId,
              pending.task,
              pending.onToolEvent,
              pending.researchMode,
              pending.hopsLeft
            );
            await runEvaAfterDelegation(
              pending.sessionId,
              pending.onToolEvent,
              pending.hopsLeft,
              onDelta,
              pending.targetAgentId
            );
          } finally {
            set({ isStreaming: false, activeDelegation: null });
            drainMessageQueue();
          }
        },

        declineDelegation: () => set({ pendingDelegation: null }),

        voiceApproveDelegation: null,
        setVoiceApproveDelegation: (fn) => set({ voiceApproveDelegation: fn }),

        sendMessage: async (text) => {
          const trimmed = text.trim();
          if (!trimmed || get().isStreaming) return;

          // Waits for cross-device sync's one-time migration (if still in
          // flight — e.g. the very first message on a device right after
          // opening it) so ensureActiveSession never creates a session that
          // migration's next step would otherwise silently overwrite. Only
          // matters once per device load — resolves immediately after.
          await whenSyncReady();

          const agentId = get().activeAgentId;
          const session = ensureActiveSession();
          const sessionId = session.id;

          const userMessage: ChatMessage = { id: newId(), role: "user", content: trimmed };
          const assistantMessage: ChatMessage = { id: newId(), role: "assistant", content: "" };

          appendMessages(sessionId, agentId, [userMessage, assistantMessage], trimmed);
          const controller = new AbortController();
          // A pending delegation approval is a real, separate decision the
          // user still owes a click on — sending a new message (even just
          // a status check like "did you do it?") must NOT silently
          // discard it; only an explicit approve/decline, or moving to a
          // different session, should. scrollToMessage is unrelated UI
          // navigation state and still fine to drop here.
          set({
            isStreaming: true,
            error: null,
            activeAbortController: controller,
            scrollToMessage: null,
          });

          const appendToAssistant = (chunk: string) =>
            appendToMessage(sessionId, agentId, assistantMessage.id, chunk);
          const onToolEvent = (event: ToolProgressPayload) =>
            updateToolEvent(sessionId, agentId, assistantMessage.id, event);

          const researchFast = agentId === "graphic" && get().researchFastMode;

          try {
            const fullText = await streamChatCompletion(
              agentId,
              sessionId,
              { role: "user", content: trimmed },
              appendToAssistant,
              onToolEvent,
              controller.signal,
              agentId === "jarvis"
                ? combineContext(
                    buildAgentActivityContext(get().sessions.find((s) => s.id === sessionId)),
                    buildPendingDelegationContext(get().pendingDelegation, sessionId),
                    buildFileContext(get().sessions.find((s) => s.id === sessionId))
                  )
                : agentId === "graphic"
                  ? researchFast
                    ? RESEARCH_FAST_MODE_CONTEXT
                    : RESEARCH_DEEP_MODE_CONTEXT
                  : undefined,
              // Fast can't reach for the browser tool at all — rendering a
              // full page is the slowest thing this agent can do, so it's
              // dropped from what's available rather than just discouraged
              // in the prompt above. "web" (search) and "skills" stay
              // available since neither involves rendering a page.
              researchFast ? ["web", "skills"] : undefined
            );

            // Awaited (not fire-and-forget) so isStreaming — and the Stop
            // button it gates — stays true for the whole delegation chain,
            // including Eva's follow-up reaction to the report, not just
            // her initial short hand-off turn. Strips any [[DELEGATE:x]]
            // marker (now something Research/Email can emit too, not just
            // Eva) before logging, so a subagent proposing a further
            // hand-off never leaks raw marker syntax into what Eva reads
            // from the activity feed below.
            const strippedText = await processDelegateMarker(
              sessionId,
              agentId,
              assistantMessage.id,
              fullText,
              onToolEvent,
              MAX_DELEGATION_HOPS
            );

            // A direct conversation with a subagent's own tab (as opposed
            // to Eva delegating to it) never otherwise reaches Eva — log it
            // here so she picks it up on her next turn. (No-op when
            // agentId is jarvis; delegateToAgent logs delegated results
            // itself, via this same activity feed.)
            recordAgentActivity(sessionId, agentId, strippedText);
          } catch (err) {
            if (!isAbortError(err)) {
              set({ error: err instanceof Error ? err.message : "Request failed" });
            } else {
              appendToAssistant("\n\n_Stopped._");
            }
          } finally {
            set({ isStreaming: false, activeAbortController: null });
            drainMessageQueue();
          }
        },

        queueMessage: (text) => {
          const trimmed = text.trim();
          const sessionId = get().activeSessionId;
          if (!trimmed || !sessionId) return;
          set((s) => ({
            messageQueue: [
              ...s.messageQueue,
              { id: newId(), sessionId, agentId: s.activeAgentId, text: trimmed },
            ],
          }));
        },

        removeQueuedMessage: (id) =>
          set((s) => ({ messageQueue: s.messageQueue.filter((q) => q.id !== id) })),

        attachFile: async (file) => {
          await whenSyncReady();
          const session = ensureActiveSession();
          const sessionId = session.id;

          set((s) => ({ pendingUploads: [...s.pendingUploads, file.name] }));
          try {
            const formData = new FormData();
            formData.append("file", file);
            const res = await fetch("/api/files/extract", { method: "POST", body: formData });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data) {
              throw new Error(data?.error || "Failed to read that file");
            }

            const attached: AttachedFile = {
              id: newId(),
              filename: data.filename,
              kind: data.kind,
              text: data.text,
              truncated: Boolean(data.truncated),
              uploadedAt: Date.now(),
            };
            set((s) => ({
              sessions: s.sessions.map((sess) =>
                sess.id === sessionId
                  ? { ...sess, attachedFiles: [...(sess.attachedFiles ?? []), attached] }
                  : sess
              ),
            }));
          } catch (err) {
            set({ error: err instanceof Error ? err.message : "Failed to upload file" });
          } finally {
            set((s) => ({ pendingUploads: s.pendingUploads.filter((n) => n !== file.name) }));
          }
        },

        removeAttachedFile: (fileId) => {
          const sessionId = get().activeSessionId;
          if (!sessionId) return;
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === sessionId
                ? { ...sess, attachedFiles: (sess.attachedFiles ?? []).filter((f) => f.id !== fileId) }
                : sess
            ),
          }));
        },

        delegateToAgent: async (
          sessionId,
          fromAgentId,
          targetAgentId,
          task,
          onToolEvent,
          researchMode,
          hopsLeft = MAX_DELEGATION_HOPS
        ) => {
          const trimmed = task.trim();
          if (!trimmed) return "";

          const userMessage: ChatMessage = { id: newId(), role: "user", content: trimmed };
          const assistantMessage: ChatMessage = { id: newId(), role: "assistant", content: "" };

          appendMessages(sessionId, targetAgentId, [userMessage, assistantMessage], trimmed);

          // Deliberately does NOT move the user's view onto the target
          // agent's tab — the user is dealing with Eva, not the
          // specialists, and force-navigating away from her tab mid-task
          // reads as the app hijacking navigation (it also cost one user
          // an accidental Stop, hit while trying to give Eva another
          // message and not realizing the tab had changed underneath
          // them). activeDelegation (set by approveDelegation) is what
          // tells the UI who's working now, so it can say so in place
          // instead; the sidebar and PendingDelegationCard read it to show
          // a "View" link for anyone who wants to actually watch.
          const appendToAssistant = (chunk: string) =>
            appendToMessage(sessionId, targetAgentId, assistantMessage.id, chunk);
          // Deliberately doesn't forward to the caller's onToolEvent — a
          // subagent's own tool calls (browser, google-workspace, etc.)
          // belong on its own tab only. Eva has no tools of her own and
          // should never show another agent's activity as if it were hers.
          const handleToolEvent = (event: ToolProgressPayload) => {
            updateToolEvent(sessionId, targetAgentId, assistantMessage.id, event);
          };

          const controller = new AbortController();
          set({ activeAbortController: controller });

          // Delegated research defaults to fast (quick answer, offer to go
          // deeper) unless Eva's marker explicitly asked for :deep — see
          // DELEGATE_MARKER. Only applies to Research; other targets are
          // unaffected.
          const isFastResearch = targetAgentId === "graphic" && researchMode !== "deep";

          // Eva's delegation task text is the primary way data reaches the
          // target agent, but it depends on her actually transcribing
          // another agent's findings into it correctly — a manual step
          // that's easy to lose data through (see DELEGATE_MARKER above for
          // the transmission half of that problem). Handing the target
          // agent the same other-agents'-findings block Eva herself sees
          // (buildAgentActivityContext) is a safety net for the other
          // half: e.g. a delegation to Email that only says "fill in the
          // 2026 columns using the research already done" still gives
          // Email direct access to Research's actual numbers, rather than
          // relying entirely on Eva to have copied them all into the task.
          const delegationSession = get().sessions.find((s) => s.id === sessionId);
          const activityContext = buildAgentActivityContext(delegationSession, undefined, true);
          // Same gap as above, but for a file the user actually attached
          // (session.attachedFiles) — sendMessage already hands this to
          // Eva's own chat via buildFileContext, but a delegation never
          // included it, so a subagent had no way to see an attached
          // workbook/PDF at all and could only work from whatever Eva
          // retyped into the task text by hand.
          const fileContext = buildFileContext(delegationSession);

          try {
            const result = await streamChatCompletion(
              targetAgentId,
              sessionId,
              { role: "user", content: trimmed },
              appendToAssistant,
              handleToolEvent,
              controller.signal,
              targetAgentId === "graphic"
                ? combineContext(
                    isFastResearch ? RESEARCH_FAST_MODE_CONTEXT : RESEARCH_DEEP_MODE_CONTEXT,
                    activityContext,
                    fileContext
                  )
                : combineContext(activityContext, fileContext),
              isFastResearch ? ["web", "skills"] : undefined
            );

            // Research and Email may now each propose handing off to the
            // OTHER one (never to Eva, never to phone — see their system
            // prompts) when their own task explicitly called for it, using
            // the same [[DELEGATE:x]] marker Eva uses. Runs through the
            // same processDelegateMarker as every other marker check, so it
            // parks a pendingDelegation for the user to approve/decline
            // rather than chaining automatically — that's what makes this
            // safe to allow again after it was previously pulled for
            // running unchecked. Strip before logging so the activity feed
            // Eva reads never contains raw marker syntax.
            const answer = result.trim() || "(no response)";
            const strippedAnswer = await processDelegateMarker(
              sessionId,
              targetAgentId,
              assistantMessage.id,
              answer,
              handleToolEvent,
              hopsLeft - 1
            );
            recordAgentActivity(sessionId, targetAgentId, strippedAnswer);
            return strippedAnswer;
          } catch (err) {
            if (isAbortError(err)) {
              appendToAssistant("\n\n_Stopped._");
              const stoppedMsg = "Stopped by user";
              recordAgentActivity(sessionId, targetAgentId, stoppedMsg);
              return stoppedMsg;
            }
            const detail = err instanceof Error ? err.message : "Request failed";
            appendToAssistant(`\n\n⚠️ Delegated request failed: ${detail}`);
            const failMsg = `⚠️ Failed — ${detail}`;
            recordAgentActivity(sessionId, targetAgentId, failMsg);
            return failMsg;
          } finally {
            set({ activeAbortController: null });
          }
        },

        // Used by the voice session's tap-to-talk pipeline (transcript in,
        // spoken answer out): routes through the SAME session/delegation
        // machinery as the text UI (real session, visible in the sidebar,
        // full [[DELEGATE:x]] support) — unlike sendMessage, this awaits
        // the final answer (including any delegated result) so it can be
        // sent to TTS. onDelta, when given, fires with each raw text chunk
        // as it streams in — VoiceSession uses this to start speaking
        // sentences as they're generated instead of waiting for the whole
        // reply, which together with VOICE_MODE_CONTEXT (below) is what
        // replaced the old generate-then-condense two-call pipeline with a
        // single call.
        askEva: async (message, onToolEvent, onDelta) => {
          const trimmed = message.trim();
          if (!trimmed) return "";

          // See sendMessage's identical guard — protects the same race for
          // the voice pipeline's first turn on a device.
          await whenSyncReady();

          const agentId: AgentId = "jarvis";
          const session = ensureActiveSession();
          const sessionId = session.id;

          const userMessage: ChatMessage = { id: newId(), role: "user", content: trimmed };
          const assistantMessage: ChatMessage = { id: newId(), role: "assistant", content: "" };

          appendMessages(sessionId, agentId, [userMessage, assistantMessage], trimmed);

          const appendToAssistant = (chunk: string) => {
            appendToMessage(sessionId, agentId, assistantMessage.id, chunk);
            onDelta?.(chunk);
          };
          const handleToolEvent = (event: ToolProgressPayload) => {
            updateToolEvent(sessionId, agentId, assistantMessage.id, event);
            onToolEvent?.(event);
          };

          const controller = new AbortController();
          set({ activeAbortController: controller });

          let fullText: string;
          try {
            fullText = await streamChatCompletion(
              agentId,
              sessionId,
              { role: "user", content: trimmed },
              appendToAssistant,
              handleToolEvent,
              controller.signal,
              combineContext(
                VOICE_MODE_CONTEXT,
                buildAgentActivityContext(session),
                buildPendingDelegationContext(get().pendingDelegation, sessionId),
                buildFileContext(session)
              )
            );
          } catch (err) {
            if (isAbortError(err)) {
              appendToAssistant("\n\n_Stopped._");
              return "Stopped.";
            }
            const detail = err instanceof Error ? err.message : "Request failed";
            appendToAssistant(`\n\n⚠️ ${detail}`);
            return `Sorry, I hit an error reaching Eva: ${detail}`;
          } finally {
            set({ activeAbortController: null });
          }

          return processDelegateMarker(sessionId, agentId, assistantMessage.id, fullText, onToolEvent, MAX_DELEGATION_HOPS);
        },
      };
    },
    {
      name: "hermes-chat-store",
      storage: createJSONStorage(() => createSyncStorage()),
      version: 1,
      migrate: () => ({
        sessions: [],
        activeSessionId: null,
        activeAgentId: DEFAULT_AGENT_ID,
        sidebarCollapsed: false,
        voiceVolume: 1,
        audioInputDeviceId: null,
        audioOutputDeviceId: null,
      }),
      partialize: (state) => ({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        activeAgentId: state.activeAgentId,
        sidebarCollapsed: state.sidebarCollapsed,
        voiceVolume: state.voiceVolume,
        audioInputDeviceId: state.audioInputDeviceId,
        audioOutputDeviceId: state.audioOutputDeviceId,
        phoneCalls: state.phoneCalls,
        phoneCallsFetchedAt: state.phoneCallsFetchedAt,
        seenFollowUpCallIds: state.seenFollowUpCallIds,
        feedbackItems: state.feedbackItems,
      }),
      // A browser that persisted activeAgentId before Case File was
      // disabled (e.g. "rag") would otherwise silently keep driving the
      // conversation through that agent forever, since it's no longer
      // reachable/settable from the UI. Snap it back to the default.
      onRehydrateStorage: () => (state) => {
        if (state && !ENABLED_AGENT_IDS.includes(state.activeAgentId)) {
          state.activeAgentId = DEFAULT_AGENT_ID;
        }
      },
    }
  )
);

// Wires up cross-device sync (see lib/syncClientStorage.ts) after the
// store exists — that module can't import useChatStore itself (it's used
// as this store's `storage`, so importing back would be circular).
subscribeSyncUpdates((partial) => useChatStore.setState(partial));
registerStreamingCheck(() => {
  const s = useChatStore.getState();
  return s.isStreaming || s.activeAbortController !== null;
});
