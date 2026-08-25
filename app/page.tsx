"use client";

import { useRef } from "react";
import { Sidebar } from "@/components/Sidebar";
import { ChatPanel } from "@/components/ChatPanel";
import { TopBar } from "@/components/TopBar";
import { SessionListView } from "@/components/SessionListView";
import { PhoneView } from "@/components/PhoneView";
import { NotificationListener } from "@/components/NotificationListener";
import { useChatStore } from "@/lib/store";

// A right-swipe anywhere on screen opens the mobile drawer, and a
// left-swipe anywhere closes it — an alternative to tapping
// TopBar/SessionListView's small hamburger button (or the drawer's own
// close button). The horizontal-vs-vertical ratio check is what keeps this
// from fighting with vertical scrolling in a list or the chat: only a drag
// that's meaningfully more horizontal than vertical counts as this gesture,
// so an ordinary scroll — even a slightly diagonal one — passes through
// untouched.
const SWIPE_THRESHOLD_PX = 60;

export default function Home() {
  const view = useChatStore((s) => s.view);
  const mobileSidebarOpen = useChatStore((s) => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useChatStore((s) => s.setMobileSidebarOpen);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStart.current.x;
    const dy = touch.clientY - touchStart.current.y;
    if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx > 0 && !mobileSidebarOpen) {
        setMobileSidebarOpen(true);
      } else if (dx < 0 && mobileSidebarOpen) {
        setMobileSidebarOpen(false);
      }
      touchStart.current = null;
    } else if (Math.abs(dy) > SWIPE_THRESHOLD_PX) {
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
