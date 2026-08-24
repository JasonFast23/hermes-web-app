"use client";

import { Sidebar } from "@/components/Sidebar";
import { ChatPanel } from "@/components/ChatPanel";
import { TopBar } from "@/components/TopBar";
import { SessionListView } from "@/components/SessionListView";
import { PhoneView } from "@/components/PhoneView";
import { NotificationListener } from "@/components/NotificationListener";
import { useChatStore } from "@/lib/store";

export default function Home() {
  const view = useChatStore((s) => s.view);

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-[#f4f6fb]">
      <NotificationListener />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {view === "sessions" ? (
          <SessionListView />
        ) : view === "phone" ? (
          <PhoneView />
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
