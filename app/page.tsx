"use client";

import { Sidebar } from "@/components/Sidebar";
import { ChatPanel } from "@/components/ChatPanel";
import { TopBar } from "@/components/TopBar";
import { SessionListView } from "@/components/SessionListView";
import { useChatStore } from "@/lib/store";

export default function Home() {
  const view = useChatStore((s) => s.view);

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-[#f4f6fb]">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {view === "sessions" ? (
          <SessionListView />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar />
            <ChatPanel />
          </div>
        )}
      </div>
    </div>
  );
}
