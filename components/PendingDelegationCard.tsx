"use client";

import { useChatStore } from "@/lib/store";
import { AGENTS } from "@/lib/agents";
import { formatPhoneNumber } from "./PhoneView";

// Shown whenever processDelegateMarker has parked a delegation OR a real
// phone call instead of running it automatically — nothing actually
// happens (no subagent call, no dialed number) until the user explicitly
// approves. Renders nothing if there's nothing pending, or it belongs to
// a session other than the one currently open. The two pending kinds are
// mutually exclusive in practice (a reply is either one marker or the
// other), so this renders whichever one is actually set.
export function PendingDelegationCard() {
  const pendingDelegation = useChatStore((s) => s.pendingDelegation);
  const pendingPhoneCall = useChatStore((s) => s.pendingPhoneCall);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const approveDelegation = useChatStore((s) => s.approveDelegation);
  const declineDelegation = useChatStore((s) => s.declineDelegation);
  const approvePhoneCall = useChatStore((s) => s.approvePhoneCall);
  const declinePhoneCall = useChatStore((s) => s.declinePhoneCall);
  // Set by VoiceSession while a voice session is open — routes the
  // post-approval confirmation through the same TTS pipeline a spoken
  // turn uses instead of the plain approve action, which only ever
  // updates text state and left voice mode silent after an approval.
  const voiceApproveDelegation = useChatStore((s) => s.voiceApproveDelegation);
  const voiceApprovePhoneCall = useChatStore((s) => s.voiceApprovePhoneCall);

  if (pendingPhoneCall && pendingPhoneCall.sessionId === activeSessionId) {
    const onApprove = () => (voiceApprovePhoneCall ? voiceApprovePhoneCall() : approvePhoneCall());
    return (
      <div className="mx-auto mb-3 w-full max-w-2xl rounded-2xl border border-black/[0.08] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <p className="text-sm text-zinc-700">
          Eva wants to call <span className="font-medium">{formatPhoneNumber(pendingPhoneCall.number)}</span>:
        </p>
        <p className="mt-1 max-h-[30vh] overflow-y-auto text-sm italic text-zinc-500">
          &ldquo;{pendingPhoneCall.purpose}&rdquo;
        </p>
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
            onClick={() => declinePhoneCall()}
            className="rounded-full border border-black/[0.1] px-4 py-1.5 text-[13px] text-zinc-600 hover:bg-black/[0.04]"
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  if (!pendingDelegation || pendingDelegation.sessionId !== activeSessionId) return null;

  const target = AGENTS[pendingDelegation.targetAgentId];
  const onApprove = () => (voiceApproveDelegation ? voiceApproveDelegation() : approveDelegation());

  return (
    <div className="mx-auto mb-3 w-full max-w-2xl rounded-2xl border border-black/[0.08] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <p className="text-sm text-zinc-700">
        Eva wants to hand this to <span className="font-medium">{target.name}</span>:
      </p>
      <p className="mt-1 max-h-[30vh] overflow-y-auto text-sm italic text-zinc-500">
        &ldquo;{pendingDelegation.task}&rdquo;
      </p>
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
