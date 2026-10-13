import type { AutomationKey } from "@/lib/programAutomation";
import { clientAllowedOps, setClientOpsChange, type ProgramReachOp, type ProgramRollout } from "@/lib/programRolloutCore";
import { AUTO_ONBOARD_TOGGLES, toggleOf } from "@/lib/clientOnboardingCore";

// ---------------------------------------------------------------------------
// "TURN EVERYTHING ON", the plan (Oct 14 2026). Pure, so the script that does
// it (scripts/_fix/oct14/turn-everything-on.ts), the forecast that previews
// it (scripts/_ops/activation-forecast.ts) and the drill read ONE answer.
//
// Jordan, Oct 13: "Can you just automate this and turn everything on when you
// are done?"
//
// WHO: the named-client list (mode PILOT), every ACTIVE real program client
// on it with their OWN list = what they have now plus everything
// autoOnboardClient turns on. Not mode ALL, because:
//   · under ALL the per-client lists stop meaning anything, and
//     "Share scripts without my approval" (switch ON since Oct 12) would reach
//     every client the day its own TEST-only lock is lifted. Jordan reviews
//     every script; on the list it is simply never added for anybody;
//   · ALL still writes Aryeo bookings only for the named list (programRolloutCore
//     header), so it is not "more on" for bookings;
//   · it is exactly what autoOnboardClient writes for a NEW client, so the bulk
//     change and the automatic onboarding agree (and Client onboarding's
//     toggles keep working per client). The list's cap is PROGRAM_PILOT_MAX (30).
// ---------------------------------------------------------------------------

/** The client-facing switches the change turns ON. */
export const SWITCHES_TURNED_ON: readonly AutomationKey[] = ["reminders", "script_share_email", "portal_invites", "portal_login_email", "program_message_notice", "auto_onboarding"];
/** Left exactly as they are: off. */
export const SWITCHES_LEFT_OFF: readonly AutomationKey[] = ["publishing", "legacy_call_sweeps"];
/** Their own TEST-only locks are left exactly as they are. */
export const LOCKS_LEFT_AS_THEY_ARE: readonly AutomationKey[] = ["script_auto_share", "review_auto_approve"];

/** The ops every active client gets (bookings only when automatic booking is proven). */
export function everythingOnOps(bookings: boolean): ProgramReachOp[] {
  return [...new Set(AUTO_ONBOARD_TOGGLES.filter((k) => k !== "bookings" || bookings).flatMap((k) => toggleOf(k).ops))];
}

export type ScopeChange = { clientId: string; name: string; had: ProgramReachOp[]; added: ProgramReachOp[] };

/**
 * The rollout with every given client on the named list, each keeping what
 * they had and gaining everythingOnOps. Applied one client at a time through
 * setClientOpsChange (the onboarding page's own change), so every rule of it
 * holds. When the list reaches nobody yet (TEST only, or no approval) and
 * someone else has choices on file, the first change sets the others to
 * nothing (they are re-added in turn if active) and `cleared` names them.
 */
export function planEveryoneInScope(
  cur: ProgramRollout,
  a: { clients: { id: string; name: string | null }[]; bookings: boolean; by: string; now: Date },
): { rollout: ProgramRollout; changes: ScopeChange[]; cleared: string[] } | { error: string } {
  const base = everythingOnOps(a.bookings);
  let r = cur;
  const changes: ScopeChange[] = [];
  let cleared: string[] = [];
  for (const c of a.clients) {
    const had = clientAllowedOps(r, c);
    const want = [...new Set([...had, ...base])];
    const added = want.filter((op) => !had.includes(op));
    if (!added.length) continue;
    let next = setClientOpsChange(r, { client: c, ops: want, by: a.by, now: a.now });
    if ("error" in next && next.othersOnFile?.length) {
      cleared = next.othersOnFile;
      next = setClientOpsChange(r, { client: c, ops: want, by: a.by, now: a.now, onlyThisClient: true });
    }
    if ("error" in next) return { error: `${c.name ?? c.id}: ${next.error}` };
    r = next;
    changes.push({ clientId: c.id, name: c.name ?? c.id, had, added });
  }
  return { rollout: r, changes, cleared };
}
