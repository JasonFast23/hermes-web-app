import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { AGENTS, AgentId, DEFAULT_AGENT_ID, ENABLED_AGENT_IDS } from "./agents";

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

// A real outbound phone call Eva proposed — [[DELEGATE:phone]], parsed
// out of PendingDelegation's flow separately since it isn't really a
// hand-off to another text-generating agent (no AgentId, no /api/chat
// call): approving it dials an actual number via Retell. sessionId is
// still needed so the confirmation message lands in the right session's
// thread once approved.
export interface PendingPhoneCall {
  sessionId: string;
  fromAgentId: AgentId;
  number: string;
  purpose: string;
}

// A ChatSession is shared across Eva/Email/Research: one id, used as the
// Hermes session key for all three profiles, so they scope memory/context
// consistently to "this session" — but each still gets its own thread of
// messages, since they're separate Hermes profiles under the hood.
export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  threads: Partial<Record<AgentId, ChatMessage[]>>;
  agentActivity: AgentActivityEntry[];
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
  // Same idea, for a proposed real phone call — see PendingPhoneCall.
  // Mutually exclusive with pendingDelegation in practice (a reply is
  // either one marker or the other), but kept as a separate field rather
  // than a union so callers don't have to narrow a targetAgentId that
  // wouldn't make sense for a phone call anyway.
  pendingPhoneCall: PendingPhoneCall | null;
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
  view: "chat" | "sessions" | "phone";
  // Set when a notification toast for a specific call is clicked (see
  // NotificationListener) — PhoneView reads and clears this on mount/
  // update to jump straight to that call's detail instead of the list.
  // Never persisted, purely a one-shot navigation hint, same pattern as
  // scrollToMessage below.
  pendingPhoneCallToOpen: string | null;
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
  setView: (view: "chat" | "sessions" | "phone") => void;
  setResearchFastMode: (fast: boolean) => void;
  setVoiceOpen: (open: boolean) => void;
  startNewSession: () => void;
  switchSession: (sessionId: string) => void;
  openSearchResult: (sessionId: string, agentId: AgentId, messageId: string, query: string) => void;
  clearScrollTarget: () => void;
  deleteSession: (sessionId: string) => void;
  deleteSessions: (sessionIds: string[]) => void;
  sendMessage: (text: string) => Promise<void>;
  delegateToAgent: (
    sessionId: string,
    fromAgentId: AgentId,
    targetAgentId: AgentId,
    task: string,
    onToolEvent?: (event: ToolProgressPayload) => void,
    researchMode?: "fast" | "deep"
  ) => Promise<string>;
  askEva: (
    message: string,
    onToolEvent?: (event: ToolProgressPayload) => void,
    onDelta?: (chunk: string) => void
  ) => Promise<string>;
  approveDelegation: (onDelta?: (chunk: string) => void) => Promise<void>;
  declineDelegation: () => void;
  // Places the real call and returns the confirmation/error text that
  // also lands in Eva's thread — the return value exists purely so a
  // voice session can speak the same text (see voiceApprovePhoneCall)
  // without needing its own onDelta-streaming plumbing, unlike
  // approveDelegation: there's nothing to stream here, just one static
  // sentence once the call is either placed or fails.
  approvePhoneCall: () => Promise<string>;
  declinePhoneCall: () => void;
  setPendingPhoneCallToOpen: (callId: string | null) => void;
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
  // Same idea as voiceApproveDelegation, but for PendingPhoneCallCard's
  // Approve button — lets VoiceSession speak the confirmation/error text
  // approvePhoneCall returns instead of it only landing in the text
  // thread silently.
  voiceApprovePhoneCall: (() => Promise<void>) | null;
  setVoiceApprovePhoneCall: (fn: (() => Promise<void>) | null) => void;
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
const DELEGATE_MARKER = /^\[\[DELEGATE:(email|research|phone)(?::(fast|deep))?\]\][ \t]*(.*)$/m;

// Parses phone's "<number>|<purpose>" task format (see lib/agents.ts) —
// deliberately permissive about the number's exact formatting (spaces,
// dashes, parens, a leading +1 or not) since it's just captured here and
// normalized server-side in /api/phone/calls/create, which is also where
// an actually-invalid number gets rejected. This only needs to split the
// two halves correctly.
const PHONE_TASK_PATTERN = /^([+()\-\s\d]{7,})\|([\s\S]+)$/;

// Caps how many delegate -> Eva-reacts -> delegate-again cycles a single
// turn can chain through, so a model that keeps re-delegating can't loop
// forever.
const MAX_DELEGATION_HOPS = 5;

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
  return {
    id: newId(),
    title: "New session",
    createdAt: Date.now(),
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
function buildAgentActivityContext(session: ChatSession | undefined): string | undefined {
  const entries = session?.agentActivity ?? [];
  if (entries.length === 0) return undefined;

  const latestByAgent = new Map<AgentId, AgentActivityEntry>();
  for (const e of entries) latestByAgent.set(e.agentId, e);

  const lines = Array.from(latestByAgent.values()).map((e) => {
    const name = AGENTS[e.agentId].name;
    const isTruncated = e.summary.length > AGENT_ACTIVITY_EXCERPT_CHARS;
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

// pendingDelegation now persists across the user's follow-up messages
// (see sendMessage) instead of silently clearing, so without this Eva has
// no way to know a delegation she proposed is still just sitting there
// unapproved — she'd otherwise answer a "did you do it?" from memory of
// having said she'd delegate, confidently claiming it's in progress when
// it never actually ran.
function buildPendingDelegationContext(pending: PendingDelegation | null, sessionId: string): string | undefined {
  if (!pending || pending.sessionId !== sessionId) return undefined;
  return (
    `You proposed delegating to the ${AGENTS[pending.targetAgentId].name} a moment ago ` +
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
        if (!match || hopsLeft <= 0) return fullText.trim();

        const rawTask = match[3].trim();
        if (!rawTask) return fullText.trim();
        const strippedText = fullText.replace(DELEGATE_MARKER, "").replace(/^\s+/, "");

        const applyStrip = () =>
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === sessionId
                ? {
                    ...sess,
                    threads: {
                      ...sess.threads,
                      [agentId]: (sess.threads[agentId] ?? []).map((m) =>
                        m.id === messageId ? { ...m, content: strippedText } : m
                      ),
                    },
                  }
                : sess
            ),
          }));

        if (match[1] === "phone") {
          const phoneMatch = PHONE_TASK_PATTERN.exec(rawTask);
          if (!phoneMatch) return fullText.trim(); // malformed — degrade to showing the raw text rather than parking a broken card
          const [, number, purpose] = phoneMatch;
          applyStrip();
          set({ pendingPhoneCall: { sessionId, fromAgentId: agentId, number: number.trim(), purpose: purpose.trim() } });
          return strippedText;
        }

        const target = DELEGATE_TARGETS[match[1]];
        // Eva's own delegation never runs deep research — that's reserved
        // for the user's manual Fast/Deep toggle on the Research tab (see
        // researchFastMode below), never something she chooses on their
        // behalf. Ignores match[2] (a stray ":deep" suffix, if the model
        // ever emits one despite the system prompt no longer describing
        // it) rather than trusting it.
        const researchMode = "fast";
        if (!target || target === agentId) return fullText.trim();

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
        onDelta?: (chunk: string) => void
      ): Promise<string> => {
        const session = get().sessions.find((s) => s.id === sessionId);

        const assistantMessage: ChatMessage = { id: newId(), role: "assistant", content: "" };
        appendMessages(sessionId, "jarvis", [assistantMessage]);
        set({ activeAgentId: "jarvis", view: "chat" });

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
        const nudge: HistoryMessage = {
          role: "user",
          content:
            "The agent you delegated to has reported back — see the " +
            "findings noted above for your awareness. In almost every " +
            "case that report already answers what the user asked, so " +
            "just relay/summarize it to them now and stop — do not " +
            "delegate again on your own initiative. In particular, if " +
            "the report offers to do more for the USER (e.g. 'if you " +
            "have a different spelling, I can search again'), that " +
            "offer is for the user to accept or decline, not something " +
            "you act on yourself by guessing what they'd say. Only " +
            "delegate again if the user's ORIGINAL request explicitly " +
            "required a further step that genuinely hasn't happened " +
            "yet.",
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
            buildAgentActivityContext(session)
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

      return {
        activeAgentId: DEFAULT_AGENT_ID,
        activeSessionId: null,
        sessions: [],
        isStreaming: false,
        activeAbortController: null,
        pendingDelegation: null,
        pendingPhoneCall: null,
        scrollToMessage: null,
        error: null,
        sidebarCollapsed: false,
        mobileSidebarOpen: false,
        view: "chat",
        pendingPhoneCallToOpen: null,
        voiceVolume: 1,
        researchFastMode: true,
        voiceOpen: false,
        audioInputDeviceId: null,
        audioOutputDeviceId: null,

        setActiveAgent: (id) => set({ activeAgentId: id, view: "chat" }),
        setView: (view) => set({ view }),
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
            pendingPhoneCall: null,
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
          set({
            activeSessionId: sessionId,
            view: "chat",
            pendingDelegation: null,
            pendingPhoneCall: null,
            scrollToMessage: null,
            researchFastMode: true,
          });
        },

        // Used by the Chats search results: jump straight to the session,
        // agent thread, and specific message a keyword matched, instead of
        // just opening the session and leaving the user to hunt for it.
        openSearchResult: (sessionId, agentId, messageId, query) => {
          if (!get().sessions.some((s) => s.id === sessionId)) return;
          set({
            activeSessionId: sessionId,
            activeAgentId: agentId,
            view: "chat",
            pendingDelegation: null,
            pendingPhoneCall: null,
            scrollToMessage: { messageId, query },
          });
        },

        clearScrollTarget: () => set({ scrollToMessage: null }),

        deleteSession: (sessionId) => {
          get().deleteSessions([sessionId]);
        },

        deleteSessions: (sessionIds) => {
          const idSet = new Set(sessionIds);
          set((s) => {
            const sessions = s.sessions.filter((sess) => !idSet.has(sess.id));
            if (!s.activeSessionId || !idSet.has(s.activeSessionId)) return { sessions };

            const next = [...sessions].sort((a, b) => b.createdAt - a.createdAt)[0];
            return { sessions, activeSessionId: next ? next.id : null };
          });
        },

        toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
        setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
        setPendingPhoneCallToOpen: (callId) => set({ pendingPhoneCallToOpen: callId }),

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
          set({ pendingDelegation: null, isStreaming: true });
          try {
            await get().delegateToAgent(
              pending.sessionId,
              pending.fromAgentId,
              pending.targetAgentId,
              pending.task,
              pending.onToolEvent,
              pending.researchMode
            );
            await runEvaAfterDelegation(pending.sessionId, pending.onToolEvent, pending.hopsLeft, onDelta);
          } finally {
            set({ isStreaming: false });
          }
        },

        declineDelegation: () => set({ pendingDelegation: null }),

        voiceApproveDelegation: null,
        setVoiceApproveDelegation: (fn) => set({ voiceApproveDelegation: fn }),

        // Places the real call. Unlike approveDelegation, there's no
        // subagent turn to await and no runEvaAfterDelegation follow-up —
        // a live phone call doesn't resolve on the timescale of one
        // request, so the only thing to do here is confirm the call was
        // placed (or report that it wasn't) and leave the actual outcome
        // for the Phone tab once the call ends.
        approvePhoneCall: async () => {
          const pending = get().pendingPhoneCall;
          if (!pending) return "";
          set({ pendingPhoneCall: null, isStreaming: true });

          let text: string;
          try {
            const res = await fetch("/api/phone/calls/create", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ number: pending.number, purpose: pending.purpose }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.callId) {
              throw new Error(data?.error || "Failed to place the call");
            }
            text = `Calling ${data.toNumber ?? pending.number} now — you'll be able to see how it went in the Phone tab once it's done.`;
          } catch (err) {
            const detail = err instanceof Error ? err.message : "Failed to place the call";
            text = `⚠️ Couldn't place that call — ${detail}`;
          } finally {
            set({ isStreaming: false });
          }

          appendMessages(pending.sessionId, pending.fromAgentId, [
            { id: newId(), role: "assistant", content: text },
          ]);
          return text;
        },

        declinePhoneCall: () => set({ pendingPhoneCall: null }),

        voiceApprovePhoneCall: null,
        setVoiceApprovePhoneCall: (fn) => set({ voiceApprovePhoneCall: fn }),

        sendMessage: async (text) => {
          const trimmed = text.trim();
          if (!trimmed || get().isStreaming) return;

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
                    buildPendingDelegationContext(get().pendingDelegation, sessionId)
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

            // A direct conversation with a subagent's own tab (as opposed
            // to Eva delegating to it) never otherwise reaches Eva — log it
            // here so she picks it up on her next turn. (No-op when
            // agentId is jarvis; delegateToAgent logs delegated results
            // itself, via this same activity feed.)
            recordAgentActivity(sessionId, agentId, fullText);

            // Awaited (not fire-and-forget) so isStreaming — and the Stop
            // button it gates — stays true for the whole delegation chain,
            // including Eva's follow-up reaction to the report, not just
            // her initial short hand-off turn.
            await processDelegateMarker(sessionId, agentId, assistantMessage.id, fullText, onToolEvent, MAX_DELEGATION_HOPS);
          } catch (err) {
            if (!isAbortError(err)) {
              set({ error: err instanceof Error ? err.message : "Request failed" });
            } else {
              appendToAssistant("\n\n_Stopped._");
            }
          } finally {
            set({ isStreaming: false, activeAbortController: null });
          }
        },

        delegateToAgent: async (sessionId, fromAgentId, targetAgentId, task, onToolEvent, researchMode) => {
          const trimmed = task.trim();
          if (!trimmed) return "";

          const userMessage: ChatMessage = { id: newId(), role: "user", content: trimmed };
          const assistantMessage: ChatMessage = { id: newId(), role: "assistant", content: "" };

          appendMessages(sessionId, targetAgentId, [userMessage, assistantMessage], trimmed);

          // Follow the hand-off live: show whichever agent is actually
          // doing the work, then switch back to the one that delegated
          // once it reports — so delegated work is as visible as the
          // delegating agent's own, in both the text and voice UI.
          set({ activeAgentId: targetAgentId, view: "chat" });

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

          try {
            const result = await streamChatCompletion(
              targetAgentId,
              sessionId,
              { role: "user", content: trimmed },
              appendToAssistant,
              handleToolEvent,
              controller.signal,
              targetAgentId === "graphic"
                ? isFastResearch
                  ? RESEARCH_FAST_MODE_CONTEXT
                  : RESEARCH_DEEP_MODE_CONTEXT
                : undefined,
              isFastResearch ? ["web", "skills"] : undefined
            );

            // Subagents are pure specialists — they never delegate further
            // (only Eva/jarvis does), so unlike the top-level case there's
            // no DELEGATE_MARKER check here. Their result is always the
            // final answer. Eva no longer gets this repeated back to her as
            // a visible "X Agent finished: ..." message in her own thread —
            // she picks it up from the activity log (recordAgentActivity)
            // the same way she picks up direct tab conversations.
            const answer = result.trim() || "(no response)";
            recordAgentActivity(sessionId, targetAgentId, answer);
            return answer;
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
            set({ activeAgentId: fromAgentId, activeAbortController: null });
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
                buildPendingDelegationContext(get().pendingDelegation, sessionId)
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
      storage: createJSONStorage(() => localStorage),
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
