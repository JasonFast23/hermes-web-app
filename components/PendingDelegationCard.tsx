"use client";

import { useChatStore } from "@/lib/store";
import { AGENTS } from "@/lib/agents";

// Shown whenever processDelegateMarker has parked a delegation instead of
// running it automatically — nothing actually happens (no subagent call)
// until the user explicitly approves. Renders nothing if there's no pending
// delegation, or it belongs to a session other than the one currently open.
export function PendingDelegationCard() {
  const pendingDelegation = useChatStore((s) => s.pendingDelegation);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const approveDelegation = useChatStore((s) => s.approveDelegation);
  const declineDelegation = useChatStore((s) => s.declineDelegation);
  // Set by VoiceSession while a voice session is open — routes Eva's
  // post-approval reply through the same TTS pipeline a spoken turn uses
  // instead of the plain approveDelegation(), which only ever updates text
  // state and left voice mode silent after a delegation was approved.
  const voiceApproveDelegation = useChatStore((s) => s.voiceApproveDelegation);

  if (!pendingDelegation || pendingDelegation.sessionId !== activeSessionId) return null;

  const target = AGENTS[pendingDelegation.targetAgentId];
  const onApprove = () => (voiceApproveDelegation ? voiceApproveDelegation() : approveDelegation());

  return (
    <div className="mx-auto mb-3 w-full max-w-2xl rounded-2xl border border-black/[0.08] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <p className="text-sm text-zinc-700">
        Eva wants to hand this to <span className="font-medium">{target.name}</span>:
      </p>
      <p className="mt-1 text-sm italic text-zinc-500">&ldquo;{pendingDelegation.task}&rdquo;</p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onApprove}
          className="rounded-full bg-zinc-900 px-4 py-1.5 text-[13px] text-white transition-opacity hover:opacity-80"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => declineDelegation()}
          className="rounded-full border border-black/[0.1] px-4 py-1.5 text-[13px] text-zinc-600 hover:bg-black/[0.04]"
        >
          Decline
        </button>
      </div>
    </div>
  );
}
