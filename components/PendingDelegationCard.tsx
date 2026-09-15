"use client";

import { useChatStore } from "@/lib/store";
import { AGENTS } from "@/lib/agents";
import { formatPhoneNumber } from "./PhoneView";

const PHONE_CALL_STATUS_LABEL: Record<string, string> = {
  queued: "Waiting to dial",
  calling: "Calling…",
  done: "Done",
  timeout: "No answer in time",
  failed: "Couldn't place",
};

// Shown whenever processDelegateMarker has parked a delegation or a phone
// batch instead of running it automatically — nothing actually happens (no
// subagent call, no dialed number) until the user explicitly approves.
// Renders nothing if there's nothing pending, or it belongs to a session
// other than the one currently open.
export function PendingDelegationCard() {
  const pendingDelegation = useChatStore((s) => s.pendingDelegation);
  const activeDelegation = useChatStore((s) => s.activeDelegation);
  const pendingPhoneBatch = useChatStore((s) => s.pendingPhoneBatch);
  const activePhoneBatch = useChatStore((s) => s.activePhoneBatch);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const approveDelegation = useChatStore((s) => s.approveDelegation);
  const declineDelegation = useChatStore((s) => s.declineDelegation);
  const approvePhoneBatch = useChatStore((s) => s.approvePhoneBatch);
  const declinePhoneBatch = useChatStore((s) => s.declinePhoneBatch);
  const setActiveAgent = useChatStore((s) => s.setActiveAgent);
  // Set by VoiceSession while a voice session is open — routes the
  // post-approval confirmation through the same TTS pipeline a spoken
  // turn uses instead of the plain approve action, which only ever
  // updates text state and left voice mode silent after an approval.
  const voiceApproveDelegation = useChatStore((s) => s.voiceApproveDelegation);

  // A batch of calls actually placing/tracking right now — shown on
  // whichever tab the user's on, same idea as activeDelegation below, with
  // live per-call progress since this can run for several minutes.
  if (activePhoneBatch && activePhoneBatch.sessionId === activeSessionId) {
    const doneCount = activePhoneBatch.calls.filter((c) => c.status !== "queued" && c.status !== "calling").length;
    return (
      <div className="mx-auto mb-3 w-full max-w-2xl rounded-2xl border border-black/[0.08] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <p className="text-sm text-zinc-600">
          <span className="font-medium text-zinc-800">Phone</span> is placing {activePhoneBatch.calls.length} call
          {activePhoneBatch.calls.length === 1 ? "" : "s"} ({doneCount}/{activePhoneBatch.calls.length} done)…
        </p>
        <ul className="mt-2 max-h-[30vh] space-y-1 overflow-y-auto text-[13px]">
          {activePhoneBatch.calls.map((c, i) => (
            <li key={i} className="flex items-center justify-between gap-2 text-zinc-600">
              <span className="min-w-0 truncate">{formatPhoneNumber(c.number)}</span>
              <span className="shrink-0 text-zinc-400">{PHONE_CALL_STATUS_LABEL[c.status]}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (pendingPhoneBatch && pendingPhoneBatch.sessionId === activeSessionId) {
    const onApprove = () => approvePhoneBatch();
    return (
      <div className="mx-auto mb-3 w-full max-w-2xl rounded-2xl border border-black/[0.08] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <p className="text-sm text-zinc-700">
          <span className="font-medium">Eva</span> wants to place {pendingPhoneBatch.calls.length} real phone call
          {pendingPhoneBatch.calls.length === 1 ? "" : "s"}:
        </p>
        <ul className="mt-1 max-h-[30vh] space-y-2 overflow-y-auto">
          {pendingPhoneBatch.calls.map((c, i) => (
            <li key={i} className="text-sm">
              <span className="font-medium text-zinc-800">{formatPhoneNumber(c.number)}</span>
              <span className="block italic text-zinc-500">&ldquo;{c.purpose}&rdquo;</span>
            </li>
          ))}
        </ul>
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
            onClick={() => declinePhoneBatch()}
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
      <p className="mt-1 max-h-[30vh] overflow-y-auto whitespace-pre-wrap text-sm italic text-zinc-500">
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
