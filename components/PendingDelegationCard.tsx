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
  const activeDelegation = useChatStore((s) => s.activeDelegation);
  const pendingPhoneCall = useChatStore((s) => s.pendingPhoneCall);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const approveDelegation = useChatStore((s) => s.approveDelegation);
  const declineDelegation = useChatStore((s) => s.declineDelegation);
  const approvePhoneCall = useChatStore((s) => s.approvePhoneCall);
  const declinePhoneCall = useChatStore((s) => s.declinePhoneCall);
  const setActiveAgent = useChatStore((s) => s.setActiveAgent);
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

  // The delegation the user just approved is actually running now — shown
  // on whichever tab they're on (they're never moved off it, see
  // delegateToAgent) so there's still visible feedback that something is
  // happening, plus a way to go watch it without that being forced.
  if (activeDelegation && activeDelegation.sessionId === activeSessionId) {
    const target = AGENTS[activeDelegation.targetAgentId];
    const alreadyThere = activeAgentId === activeDelegation.targetAgentId;
    return (
      <div className="mx-auto mb-3 flex w-full max-w-2xl items-center justify-between gap-3 rounded-2xl border border-black/[0.08] bg-white px-4 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <p className="min-w-0 truncate text-sm text-zinc-600">
          <span className="font-medium text-zinc-800">{target.name}</span> is working on:{" "}
          <span className="italic text-zinc-500">&ldquo;{activeDelegation.task}&rdquo;</span>
        </p>
        {!alreadyThere && (
          <button
            type="button"
            onClick={() => setActiveAgent(activeDelegation.targetAgentId)}
            className="shrink-0 rounded-full border border-black/[0.1] px-3 py-1 text-[13px] text-zinc-600 hover:bg-black/[0.04]"
          >
            View
          </button>
        )}
      </div>
    );
  }

  if (!pendingDelegation || pendingDelegation.sessionId !== activeSessionId) return null;

  const target = AGENTS[pendingDelegation.targetAgentId];
  // Research and Email can now propose delegating directly to each other,
  // not just Eva — name the actual proposer rather than always saying Eva.
  const source = AGENTS[pendingDelegation.fromAgentId];
  const onApprove = () => (voiceApproveDelegation ? voiceApproveDelegation() : approveDelegation());

  return (
    <div className="mx-auto mb-3 w-full max-w-2xl rounded-2xl border border-black/[0.08] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <p className="text-sm text-zinc-700">
        <span className="font-medium">{source.name}</span> wants to hand this to{" "}
        <span className="font-medium">{target.name}</span>:
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
