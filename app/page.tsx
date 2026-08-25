"use client";

import { useRef } from "react";
import { Sidebar } from "@/components/Sidebar";
import { ChatPanel } from "@/components/ChatPanel";
import { TopBar } from "@/components/TopBar";
import { SessionListView } from "@/components/SessionListView";
import { PhoneView } from "@/components/PhoneView";
import { NotificationListener } from "@/components/NotificationListener";
import { useChatStore } from "@/lib/store";

// A right-swipe-from-the-left-edge opens the mobile drawer, as an
// alternative to tapping TopBar/SessionListView's small hamburger button.
// Only arms when the touch *starts* within EDGE_ZONE_PX of the left edge
// (like a native OS edge-swipe) so an ordinary horizontal-ish drag or tap
// anywhere else on screen — e.g. scrolling a list that happens to start
// near the edge — can't trigger it by accident. The horizontal-vs-vertical
// ratio check on top of that means a mostly-vertical scroll starting in the
// zone still won't fire it either.
const EDGE_ZONE_PX = 56;
const OPEN_THRESHOLD_PX = 60;

export default function Home() {
  const view = useChatStore((s) => s.view);
  const mobileSidebarOpen = useChatStore((s) => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useChatStore((s) => s.setMobileSidebarOpen);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (mobileSidebarOpen) return;
    const touch = e.touches[0];
    touchStart.current = touch.clientX <= EDGE_ZONE_PX ? { x: touch.clientX, y: touch.clientY } : null;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStart.current.x;
    const dy = touch.clientY - touchStart.current.y;
    if (dx > OPEN_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      setMobileSidebarOpen(true);
      touchStart.current = null;
    } else if (Math.abs(dy) > OPEN_THRESHOLD_PX) {
      touchStart.current = null;
    }
  };

  return (
    <div
      className="flex h-dvh w-full touch-pan-y flex-col overflow-hidden bg-[#f4f6fb]"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={() => {
        touchStart.current = null;
      }}
    >
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
