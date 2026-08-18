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
  // Set when a Chats-search result is clicked: which message to scroll to
  // and briefly highlight in the chat panel, and the query that matched it
  // (so the exact matched text, not just the message, can be marked).
  // Never persisted — purely a one-shot navigation hint for ChatPanel.
  scrollToMessage: { messageId: string; query: string } | null;
  error: string | null;
  sidebarCollapsed: boolean;
  view: "chat" | "sessions";
  // 0 (silent) to 1 (full) — controls playback volume for Eva's spoken
  // replies in VoiceSession. Persisted like other UI preferences below.
  voiceVolume: number;
  // When true, a direct message to the Research agent asks for a quick,
  // single-answer overview (like a search engine's AI Overview) instead of
  // the default multi-source dig. Never persisted — resets to the thorough
  // default each load rather than silently staying in a mode the user
  // picked once and may not remember is still on.
  researchFastMode: boolean;

  setActiveAgent: (id: AgentId) => void;
  setView: (view: "chat" | "sessions") => void;
  setResearchFastMode: (fast: boolean) => void;
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
  askEva: (message: string, onToolEvent?: (event: ToolProgressPayload) => void) => Promise<string>;
  approveDelegation: () => Promise<void>;
  declineDelegation: () => void;
  toggleSidebar: () => void;
  setVoiceVolume: (volume: number) => void;
  stopStreaming: () => void;
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
const DELEGATE_MARKER = /^\[\[DELEGATE:(email|research)(?::(fast|deep))?\]\][ \t]*(.*)$/m;

// Caps how many delegate -> Eva-reacts -> delegate-again cycles a single
// turn can chain through, so a model that keeps re-delegating can't loop
// forever.
const MAX_DELEGATION_HOPS = 5;

function createSession(): ChatSession {
  return {
    id: crypto.randomUUID(),
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
    const excerpt = isTruncated ? `${e.summary.slice(0, AGENT_ACTIVITY_EXCERPT_CHARS)}…` : e.summary;
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
// Deliberately does NOT tell Eva to write briefly or avoid markdown —
// this text becomes the actual chat message shown on screen too (same
// appendToAssistant that powers the visible transcript), so shaping her
// writing style here would make the on-screen answer short/plain as a
// side effect, not just the spoken one. She should write exactly as she
// would for typed chat; VoiceSession's own condense pass + client-side
// markdown stripping are what shape what's actually spoken, entirely
// separately from what's displayed. Only worth telling her here is
// something that's actually true because this came in by voice: that a
// delegation can't be approved by voice.
const VOICE_MODE_CONTEXT =
  "This question came in by voice. If this needs delegating to Research " +
  "or Email, say so briefly and mention the user will need to check the " +
  "app to approve it before it actually runs — voice can't approve that " +
  "for you.";

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
  "more depth after this, they'll ask — don't pre-empt that here.";

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
  "settling for the first result.";

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

        const target = DELEGATE_TARGETS[match[1]];
        const researchMode = match[2] === "deep" ? "deep" : "fast";
        const task = match[3].trim();
        if (!target || !task || target === agentId) return fullText.trim();

        const strippedText = fullText.replace(DELEGATE_MARKER, "").replace(/^\s+/, "");

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
          pendingDelegation: {
            sessionId,
            fromAgentId: agentId,
            targetAgentId: target,
            task,
            hopsLeft,
            onToolEvent,
            researchMode,
          },
        }));

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
        hopsLeft: number
      ): Promise<string> => {
        const session = get().sessions.find((s) => s.id === sessionId);

        const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };
        appendMessages(sessionId, "jarvis", [assistantMessage]);
        set({ activeAgentId: "jarvis", view: "chat" });

        const appendToAssistant = (chunk: string) => appendToMessage(sessionId, "jarvis", assistantMessage.id, chunk);
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
        scrollToMessage: null,
        error: null,
        sidebarCollapsed: false,
        view: "chat",
        voiceVolume: 1,
        researchFastMode: false,

        setActiveAgent: (id) => set({ activeAgentId: id, view: "chat" }),
        setView: (view) => set({ view }),
        setVoiceVolume: (volume) => set({ voiceVolume: Math.min(1, Math.max(0, volume)) }),
        setResearchFastMode: (fast) => set({ researchFastMode: fast }),

        startNewSession: () => {
          // Don't create a session record yet — just clear the active
          // selection so the panel shows a blank slate. A real session is
          // only added to the list (via ensureActiveSession) once the user
          // actually sends a first message, matching Claude's "New chat".
          set({ activeSessionId: null, view: "chat", pendingDelegation: null, scrollToMessage: null });
        },

        switchSession: (sessionId) => {
          if (!get().sessions.some((s) => s.id === sessionId)) return;
          // A pending approval (or search-result scroll target) belongs to
          // the session that raised it — don't let it linger and fire out
          // of context after switching.
          set({ activeSessionId: sessionId, view: "chat", pendingDelegation: null, scrollToMessage: null });
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
        approveDelegation: async () => {
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
            await runEvaAfterDelegation(pending.sessionId, pending.onToolEvent, pending.hopsLeft);
          } finally {
            set({ isStreaming: false });
          }
        },

        declineDelegation: () => set({ pendingDelegation: null }),

        sendMessage: async (text) => {
          const trimmed = text.trim();
          if (!trimmed || get().isStreaming) return;

          const agentId = get().activeAgentId;
          const session = ensureActiveSession();
          const sessionId = session.id;

          const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: trimmed };
          const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };

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

          const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: trimmed };
          const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };

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
        // sent to TTS.
        askEva: async (message, onToolEvent) => {
          const trimmed = message.trim();
          if (!trimmed) return "";

          const agentId: AgentId = "jarvis";
          const session = ensureActiveSession();
          const sessionId = session.id;

          const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: trimmed };
          const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };

          appendMessages(sessionId, agentId, [userMessage, assistantMessage], trimmed);

          const appendToAssistant = (chunk: string) => appendToMessage(sessionId, agentId, assistantMessage.id, chunk);
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
      }),
      partialize: (state) => ({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        activeAgentId: state.activeAgentId,
        sidebarCollapsed: state.sidebarCollapsed,
        voiceVolume: state.voiceVolume,
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
