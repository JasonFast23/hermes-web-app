"use client";

import { useMemo, useState } from "react";
import { AGENTS, ENABLED_AGENT_IDS } from "@/lib/agents";
import { ChatSession, useChatStore } from "@/lib/store";
import { AboutModal } from "./AboutModal";
import {
  AgentsIcon,
  InfoIcon,
  MessagingIcon,
  PanelToggleIcon,
  PhoneIcon,
  PlusIcon,
  TrashIcon,
} from "./Icons";

const AGENT_ORDER = ENABLED_AGENT_IDS;

const DATE_GROUP_ORDER = ["Today", "Yesterday", "Older"] as const;

function dateGroup(createdAt: number): (typeof DATE_GROUP_ORDER)[number] {
  const startOfDay = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diffDays = Math.round((startOfDay(Date.now()) - startOfDay(createdAt)) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return "Older";
}

function SessionStack({ onNavigate }: { onNavigate?: () => void }) {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const groups = useMemo(() => {
    const bucket: Record<string, ChatSession[]> = {};
    [...sessions]
      .sort((a, b) => b.createdAt - a.createdAt)
      .forEach((sess) => {
        const label = dateGroup(sess.createdAt);
        (bucket[label] ??= []).push(sess);
      });
    return bucket;
  }, [sessions]);

  if (sessions.length === 0) return null;

  return (
    <div className="mt-4 flex flex-col gap-0.5">
      {DATE_GROUP_ORDER.filter((label) => groups[label]?.length).map((label) => (
        <div key={label} className="mt-1">
          <div className="px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
            {label}
          </div>
          {groups[label].map((sess) => (
            <div key={sess.id} className="group relative flex items-center">
              <button
                type="button"
                onClick={() => {
                  switchSession(sess.id);
                  onNavigate?.();
                }}
                title={sess.title}
                className={`block w-full truncate rounded-lg py-1.5 pl-2.5 pr-7 text-left text-[13.5px] transition-colors ${
                  sess.id === activeSessionId
                    ? "bg-black/[0.05] text-zinc-900"
                    : "text-zinc-600 hover:bg-black/[0.04] hover:text-zinc-800"
                }`}
              >
                {sess.title}
              </button>
              <button
                type="button"
                onClick={() => deleteSession(sess.id)}
                aria-label={`Delete "${sess.title}"`}
                className="absolute right-1 flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 opacity-0 transition-opacity hover:bg-black/[0.08] hover:text-red-500 group-hover:opacity-100"
              >
                <TrashIcon className="h-[14px] w-[14px]" />
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function CollapsedRail({
  toggleSidebar,
  startNewSession,
  view,
  setView,
  onOpenAbout,
}: {
  toggleSidebar: () => void;
  startNewSession: () => void;
  view: "chat" | "sessions" | "phone";
  setView: (view: "chat" | "sessions" | "phone") => void;
  onOpenAbout: () => void;
}) {
  return (
    <div className="flex h-full w-14 flex-col items-center py-3">
      <button
        type="button"
        aria-label="Expand sidebar"
        onClick={toggleSidebar}
        className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-500 hover:bg-black/[0.05]"
      >
        <PanelToggleIcon className="h-[18px] w-[18px]" />
      </button>
      <button
        type="button"
        aria-label="New session"
        title="New session"
        onClick={startNewSession}
        className="mt-2 flex h-9 w-9 items-center justify-center rounded-md text-zinc-500 hover:bg-black/[0.05]"
      >
        <PlusIcon className="h-[18px] w-[18px]" />
      </button>
      <button
        type="button"
        aria-label="Chats"
        title="Chats"
        onClick={() => setView("sessions")}
        className={`flex h-9 w-9 items-center justify-center rounded-md ${
          view === "sessions" ? "bg-black/[0.06] text-zinc-900" : "text-zinc-500 hover:bg-black/[0.05]"
        }`}
      >
        <MessagingIcon className="h-[18px] w-[18px]" />
      </button>
      <button
        type="button"
        aria-label="Phone"
        title="Phone"
        onClick={() => setView("phone")}
        className={`mt-2 flex h-9 w-9 items-center justify-center rounded-md ${
          view === "phone" ? "bg-black/[0.06] text-zinc-900" : "text-zinc-500 hover:bg-black/[0.05]"
        }`}
      >
        <PhoneIcon className="h-[18px] w-[18px]" />
      </button>
      <button
        type="button"
        aria-label="About"
        title="About"
        onClick={onOpenAbout}
        className="mt-auto flex h-9 w-9 items-center justify-center rounded-md text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-600"
      >
        <InfoIcon className="h-[18px] w-[18px]" />
      </button>
    </div>
  );
}

// The full sidebar contents — shared by the desktop expanded rail and the
// mobile off-canvas drawer (see Sidebar below). onNavigate fires after any
// action that changes what's on screen (new session, switching view/session/
// agent) so the mobile drawer closes itself the same way tapping a link in
// a phone app's menu normally does; it's undefined on desktop, where there's
// no drawer to close. onCollapse renders the header's toggle button — on
// desktop it collapses to the icon rail, on mobile it just closes the
// drawer, hence the generic name.
function SidebarPanel({
  onNavigate,
  onCollapse,
  onOpenAbout,
}: {
  onNavigate?: () => void;
  onCollapse: () => void;
  onOpenAbout: () => void;
}) {
  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const setActiveAgent = useChatStore((s) => s.setActiveAgent);
  const startNewSession = useChatStore((s) => s.startNewSession);
  const view = useChatStore((s) => s.view);
  const setView = useChatStore((s) => s.setView);

  return (
    <div className="flex w-[260px] shrink-0 flex-col">
      <div className="flex items-center justify-between p-3 pb-0">
        <span className="px-1 text-lg font-semibold tracking-tight text-zinc-800">Eva</span>
        <button
          type="button"
          aria-label="Collapse sidebar"
          onClick={onCollapse}
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-black/[0.05]"
        >
          <PanelToggleIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3 pt-1">
        <button
          type="button"
          onClick={() => {
            startNewSession();
            onNavigate?.();
          }}
          className="group flex items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-zinc-600 transition-colors hover:bg-black/[0.04]"
        >
          <PlusIcon className="h-[18px] w-[18px] shrink-0 text-zinc-500" />
          <span className="truncate">New session</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setView("sessions");
            onNavigate?.();
          }}
          className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors ${
            view === "sessions"
              ? "bg-black/[0.05] text-zinc-900"
              : "text-zinc-600 hover:bg-black/[0.04]"
          }`}
        >
          <MessagingIcon className="h-[18px] w-[18px] shrink-0 text-zinc-500" />
          <span className="truncate">Chats</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setView("phone");
            onNavigate?.();
          }}
          className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors ${
            view === "phone"
              ? "bg-black/[0.05] text-zinc-900"
              : "text-zinc-600 hover:bg-black/[0.04]"
          }`}
        >
          <PhoneIcon className="h-[18px] w-[18px] shrink-0 text-zinc-500" />
          <span className="truncate">Phone</span>
        </button>

        <div className="mt-4 flex items-center gap-3 px-2.5 py-1.5 text-[13.5px] font-medium text-zinc-500">
          <AgentsIcon className="h-[18px] w-[18px] shrink-0 text-zinc-500" />
          <span>Agents</span>
        </div>

        <div className="mt-0.5 flex flex-col gap-0.5">
          {AGENT_ORDER.map((id) => {
            const isJarvis = id === "jarvis";
            const isActive = id === activeAgentId;
            const label = isJarvis ? "Eva (Manager)" : AGENTS[id].name;

            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setActiveAgent(id);
                  onNavigate?.();
                }}
                title={label}
                className={`flex w-full items-center rounded-lg py-1.5 text-left text-[13.5px] transition-colors ${
                  isJarvis ? "pl-[38px] pr-2.5 font-medium" : "pl-[54px] pr-2.5"
                } ${
                  isActive
                    ? "bg-black/[0.05] text-zinc-900"
                    : isJarvis
                      ? "text-zinc-800 hover:bg-black/[0.04]"
                      : "text-zinc-500 hover:bg-black/[0.04] hover:text-zinc-700"
                }`}
              >
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>

        <SessionStack onNavigate={onNavigate} />
      </nav>

      <div className="border-t border-black/[0.06] p-3 pt-2">
        <button
          type="button"
          onClick={() => {
            onOpenAbout();
            onNavigate?.();
          }}
          className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] text-zinc-400 transition-colors hover:bg-black/[0.04] hover:text-zinc-600"
        >
          <InfoIcon className="h-[16px] w-[16px] shrink-0" />
          <span>About</span>
        </button>
      </div>
    </div>
  );
}

export function Sidebar() {
  const collapsed = useChatStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const startNewSession = useChatStore((s) => s.startNewSession);
  const view = useChatStore((s) => s.view);
  const setView = useChatStore((s) => s.setView);
  const mobileOpen = useChatStore((s) => s.mobileSidebarOpen);
  const setMobileOpen = useChatStore((s) => s.setMobileSidebarOpen);
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <>
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}

      {/* Desktop: a permanent layout column, collapsible between the icon
          rail and the full-width panel. Hidden entirely below md — on a
          phone-width screen it's the off-canvas drawer just below instead. */}
      <aside
        className={`hidden shrink-0 overflow-hidden border-r border-black/[0.06] bg-[#fafafa] transition-[width] duration-200 md:flex ${
          collapsed ? "w-14" : "w-[260px]"
        }`}
      >
        {collapsed ? (
          <CollapsedRail
            toggleSidebar={toggleSidebar}
            startNewSession={startNewSession}
            view={view}
            setView={setView}
            onOpenAbout={() => setAboutOpen(true)}
          />
        ) : (
          <SidebarPanel onCollapse={toggleSidebar} onOpenAbout={() => setAboutOpen(true)} />
        )}
      </aside>

      {/* Mobile: an off-canvas drawer over the content, opened by a
          hamburger button in TopBar/SessionListView — never a layout
          column, since it would have to eat the entire screen width to be
          usable at a phone's size. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <div className="relative flex h-full max-w-[85vw] flex-col bg-[#fafafa] pt-[env(safe-area-inset-top)] shadow-xl">
            <SidebarPanel
              onNavigate={() => setMobileOpen(false)}
              onCollapse={() => setMobileOpen(false)}
              onOpenAbout={() => setAboutOpen(true)}
            />
          </div>
        </div>
      )}
    </>
  );
}
