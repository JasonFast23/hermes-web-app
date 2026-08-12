import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { AGENTS, AgentId, DEFAULT_AGENT_ID } from "./agents";

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

// A ChatSession is shared across Eva/Email/Research: one id, used as the
// Hermes session key for all three profiles, so they scope memory/context
// consistently to "this session" — but each still gets its own thread of
// messages, since they're separate Hermes profiles under the hood.
export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  threads: Partial<Record<AgentId, ChatMessage[]>>;
}

interface ChatState {
  activeAgentId: AgentId;
  activeSessionId: string | null;
  sessions: ChatSession[];
  isStreaming: boolean;
  error: string | null;
  sidebarCollapsed: boolean;
  view: "chat" | "sessions";
  // 0 (silent) to 1 (full) — controls playback volume for Eva's spoken
  // replies in VoiceSession. Persisted like other UI preferences below.
  voiceVolume: number;

  setActiveAgent: (id: AgentId) => void;
  setView: (view: "chat" | "sessions") => void;
  startNewSession: () => void;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  deleteSessions: (sessionIds: string[]) => void;
  sendMessage: (text: string) => Promise<void>;
  delegateToAgent: (
    sessionId: string,
    fromAgentId: AgentId,
    targetAgentId: AgentId,
    task: string,
    onToolEvent?: (event: ToolProgressPayload) => void
  ) => Promise<string>;
  askEva: (message: string, onToolEvent?: (event: ToolProgressPayload) => void) => Promise<string>;
  toggleSidebar: () => void;
  setVoiceVolume: (volume: number) => void;
}

// Eva (and now Email/Research) emit a line like "[[DELEGATE:email]] draft a
// reply to..." when they want to hand a task to another profile. Maps the
// marker keyword to the internal AgentId (the Research tab's id is
// "graphic", not "research").
const DELEGATE_TARGETS: Record<string, AgentId> = {
  email: "email",
  research: "graphic",
};
const DELEGATE_MARKER = /^\[\[DELEGATE:(email|research)\]\][ \t]*(.*)$/m;

function createSession(): ChatSession {
  return {
    id: crypto.randomUUID(),
    title: "New session",
    createdAt: Date.now(),
    threads: {},
  };
}

function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "New session";
  return trimmed.length > 40 ? trimmed.slice(0, 40) + "…" : trimmed;
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

// Drops empty entries (e.g. an assistant turn left blank by a failed
// request) so they don't show up as blank turns in the history we replay.
function toHistory(messages: ChatMessage[]): HistoryMessage[] {
  return messages
    .filter((m) => m.content.trim() !== "")
    .map((m) => ({ role: m.role, content: m.content }));
}

async function streamChatCompletion(
  agentId: AgentId,
  sessionKey: string,
  history: HistoryMessage[],
  onDelta: (chunk: string) => void,
  onToolEvent?: (event: ToolProgressPayload) => void
): Promise<string> {
  let fullText = "";

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: history,
      agentId,
      sessionKey,
    }),
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

      return {
        activeAgentId: DEFAULT_AGENT_ID,
        activeSessionId: null,
        sessions: [],
        isStreaming: false,
        error: null,
        sidebarCollapsed: false,
        view: "chat",
        voiceVolume: 1,

        setActiveAgent: (id) => set({ activeAgentId: id, view: "chat" }),
        setView: (view) => set({ view }),
        setVoiceVolume: (volume) => set({ voiceVolume: Math.min(1, Math.max(0, volume)) }),

        startNewSession: () => {
          // Don't create a session record yet — just clear the active
          // selection so the panel shows a blank slate. A real session is
          // only added to the list (via ensureActiveSession) once the user
          // actually sends a first message, matching Claude's "New chat".
          set({ activeSessionId: null, view: "chat" });
        },

        switchSession: (sessionId) => {
          if (!get().sessions.some((s) => s.id === sessionId)) return;
          set({ activeSessionId: sessionId, view: "chat" });
        },

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

        sendMessage: async (text) => {
          const trimmed = text.trim();
          if (!trimmed || get().isStreaming) return;

          const agentId = get().activeAgentId;
          const session = ensureActiveSession();
          const sessionId = session.id;

          const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: trimmed };
          const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };

          const history = [...toHistory(session.threads[agentId] ?? []), { role: "user" as const, content: trimmed }];

          appendMessages(sessionId, agentId, [userMessage, assistantMessage], trimmed);
          set({ isStreaming: true, error: null });

          const appendToAssistant = (chunk: string) =>
            appendToMessage(sessionId, agentId, assistantMessage.id, chunk);
          const onToolEvent = (event: ToolProgressPayload) =>
            updateToolEvent(sessionId, agentId, assistantMessage.id, event);

          try {
            const fullText = await streamChatCompletion(agentId, sessionId, history, appendToAssistant, onToolEvent);

            const match = DELEGATE_MARKER.exec(fullText);
            if (match) {
              const target = DELEGATE_TARGETS[match[1]];
              const task = match[2].trim();

              set((s) => ({
                sessions: s.sessions.map((sess) =>
                  sess.id === sessionId
                    ? {
                        ...sess,
                        threads: {
                          ...sess.threads,
                          [agentId]: (sess.threads[agentId] ?? []).map((m) =>
                            m.id === assistantMessage.id
                              ? { ...m, content: m.content.replace(DELEGATE_MARKER, "").replace(/^\s+/, "") }
                              : m
                          ),
                        },
                      }
                    : sess
                ),
              }));

              if (target && task && target !== agentId) {
                get().delegateToAgent(sessionId, agentId, target, task);
              }
            }
          } catch (err) {
            set({ error: err instanceof Error ? err.message : "Request failed" });
          } finally {
            set({ isStreaming: false });
          }
        },

        delegateToAgent: async (sessionId, fromAgentId, targetAgentId, task, onToolEvent) => {
          const trimmed = task.trim();
          if (!trimmed) return "";

          const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: trimmed };
          const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };

          const targetSession = get().sessions.find((s) => s.id === sessionId);
          const history = [
            ...toHistory(targetSession?.threads[targetAgentId] ?? []),
            { role: "user" as const, content: trimmed },
          ];

          appendMessages(sessionId, targetAgentId, [userMessage, assistantMessage], trimmed);

          // Follow the hand-off live: show whichever agent is actually
          // doing the work, then switch back to the one that delegated
          // once it reports — so delegated work is as visible as the
          // delegating agent's own, in both the text and voice UI.
          set({ activeAgentId: targetAgentId, view: "chat" });

          const appendToAssistant = (chunk: string) =>
            appendToMessage(sessionId, targetAgentId, assistantMessage.id, chunk);
          const handleToolEvent = (event: ToolProgressPayload) => {
            updateToolEvent(sessionId, targetAgentId, assistantMessage.id, event);
            onToolEvent?.(event);
          };

          const reportBack = (summary: string) => {
            appendMessages(sessionId, fromAgentId, [
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `${AGENTS[targetAgentId].name} finished:\n${summary}`,
              },
            ]);
          };

          try {
            const result = await streamChatCompletion(targetAgentId, sessionId, history, appendToAssistant, handleToolEvent);

            // The delegated agent can itself hand off further (e.g.
            // Research -> Email) — same marker convention as the top-level
            // Eva case. Guard against immediate bounce-back to whoever
            // delegated to us, and against self-delegation.
            const match = DELEGATE_MARKER.exec(result);
            const nextTarget = match ? DELEGATE_TARGETS[match[1]] : undefined;
            const nextTask = match ? match[2].trim() : "";
            const willDelegateFurther = !!(
              match &&
              nextTarget &&
              nextTask &&
              nextTarget !== targetAgentId &&
              nextTarget !== fromAgentId
            );

            if (match) {
              set((s) => ({
                sessions: s.sessions.map((sess) =>
                  sess.id === sessionId
                    ? {
                        ...sess,
                        threads: {
                          ...sess.threads,
                          [targetAgentId]: (sess.threads[targetAgentId] ?? []).map((m) =>
                            m.id === assistantMessage.id
                              ? { ...m, content: m.content.replace(DELEGATE_MARKER, "").replace(/^\s+/, "") }
                              : m
                          ),
                        },
                      }
                    : sess
                ),
              }));
            }

            if (willDelegateFurther) {
              const answer = await get().delegateToAgent(sessionId, targetAgentId, nextTarget!, nextTask, onToolEvent);
              reportBack(answer);
              return answer;
            }

            const answer = result.trim() || "(no response)";
            reportBack(answer);
            return answer;
          } catch (err) {
            const detail = err instanceof Error ? err.message : "Request failed";
            appendToAssistant(`\n\n⚠️ Delegated request failed: ${detail}`);
            const failMsg = `⚠️ Failed — ${detail}`;
            reportBack(failMsg);
            return failMsg;
          } finally {
            set({ activeAgentId: fromAgentId });
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

          const history = [...toHistory(session.threads[agentId] ?? []), { role: "user" as const, content: trimmed }];

          appendMessages(sessionId, agentId, [userMessage, assistantMessage], trimmed);

          const appendToAssistant = (chunk: string) =>
            appendToMessage(sessionId, agentId, assistantMessage.id, chunk);
          const handleToolEvent = (event: ToolProgressPayload) => {
            updateToolEvent(sessionId, agentId, assistantMessage.id, event);
            onToolEvent?.(event);
          };

          let fullText: string;
          try {
            fullText = await streamChatCompletion(agentId, sessionId, history, appendToAssistant, handleToolEvent);
          } catch (err) {
            const detail = err instanceof Error ? err.message : "Request failed";
            appendToAssistant(`\n\n⚠️ ${detail}`);
            return `Sorry, I hit an error reaching Eva: ${detail}`;
          }

          const match = DELEGATE_MARKER.exec(fullText);
          if (match) {
            const target = DELEGATE_TARGETS[match[1]];
            const task = match[2].trim();

            set((s) => ({
              sessions: s.sessions.map((sess) =>
                sess.id === sessionId
                  ? {
                      ...sess,
                      threads: {
                        ...sess.threads,
                        [agentId]: (sess.threads[agentId] ?? []).map((m) =>
                          m.id === assistantMessage.id
                            ? { ...m, content: m.content.replace(DELEGATE_MARKER, "").replace(/^\s+/, "") }
                            : m
                        ),
                      },
                    }
                  : sess
              ),
            }));

            if (target && task && target !== agentId) {
              return get().delegateToAgent(sessionId, agentId, target, task, onToolEvent);
            }
          }

          return fullText.trim();
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
    }
  )
);
