import "server-only";
import { prisma } from "@/lib/prisma";
import type { ProgramReachOp, ReachRefusalCode, ReachTier } from "@/lib/programRolloutCore";

// ---------------------------------------------------------------------------
// "WHAT WOULD GO OUT NOW?" — every client-reaching lane, read-only (R03, Sep
// 28 2026).
//
// WHY. The reminder dry run was the only preview, and it dropped the address
// lane, showed no recipient for the script-approval lane or for any real
// client, and judged a TEST client's address by a different rule than the
// outbox floor — so it could say "send" for a message dispatch then refused
// with a throw. The share notices, the office-replied notices, held portal
// access and automatic sharing had no preview at all.
//
// WHAT. One list, built ONLY by calling the functions the sends themselves
// run, in their dry-run mode, with the same fresh rollout read and the same
// verified-inbox rule:
//   · programReminders.evaluateReminders({ dryRun: true }) — the planning and
//     review lanes, the address lane and the script-approval lane;
//   · scriptShare.drainShareNotices({ dryRun: true }) — scripts/strategy ready;
//   · programMessages.sweepProgramMessageNotices({ dryRun: true });
//   · portalAccess.previewHeldAccessRelease() — the classifier Release runs;
//   · scriptAutoShare.sweepAutoShare({ dryRun: true });
//   · and, per client with a program, the portal layout
//     (portalLayout.layoutForClient — what their page will show), review
//     deadlines (reviewWindows.revisionPolicyFor) and topic carry-over
//     (programRollout.programAudience, the switch's own audience).
// Every recipient is masked and was computed BEFORE the scope said no, so an
// excluded client's row still shows who would have been reached. So what this
// marks "send", what readiness names, and what dispatch lets through are the
// same answer; the outbox gate (programRolloutGate) is the last check, with
// the same predicate.
//
// WRITES NOTHING: no claim, no ledger row, no outbox row, no pin. A lane whose
// read fails is one "could not be previewed" row, never a silent gap.
//
// "SEND" MEANS THE NEXT LIVE RUN DOES IT (review fix, Sep 28 2026). Three
// lanes disagreed with dispatch: the reminder dry run evaluates on the default
// policy even with reminders OFF (its hourly run then evaluates nothing), so
// every reminder row now reads "no — reminders is off" while the switch is
// off; the auto-share dry run marked every draft the next run would release
// as "no" (it is `wouldShare` now, and "send" only while script_auto_share is
// on); and the office-replied lane had no TEST floor (programMessages skips a
// TEST seat on an unverified inbox in both runs now).
// ---------------------------------------------------------------------------

export type AudienceLane =
  | "PLANNING" | "REVIEW" | "ADDRESS" | "APPROVE_SCRIPTS"
  | "SCRIPTS_READY" | "STRATEGY_READY" | "OFFICE_REPLIED"
  | "HELD_ACCESS" | "AUTO_SHARE"
  | "LAYOUT" | "REVIEW_DEADLINES" | "TOPIC_CARRYOVER";

export type AudiencePreviewRow = {
  lane: AudienceLane;
  op: ProgramReachOp;
  clientId: string | null;
  clientName: string;
  /** TEST / PILOT / ALL when the rollout reaches them for this op; null when it does not (see code). */
  tier: ReachTier | null;
  /** The rollout's refusal, when it refused. */
  code: ReachRefusalCode | null;
  /** Masked; null when the lane has no address (a portal change). */
  to: string | null;
  /**
   *   send        happens on the next run (an email, or a change on their portal)
   *   wait        not yet (a later moment, the window is closed, a hold)
   *   on_release  only when the owner presses Release (held portal access)
   *   no          will not happen (suppressed, skipped, out of scope)
   */
  decision: "send" | "wait" | "on_release" | "no";
  /** The lane's own words for its decision ("suppressed · launch_not_authorised"). */
  detail: string;
  reason: string;
};

type Audience = { tier: ReachTier | null; code: ReachRefusalCode | null } | null | undefined;
const aud = (a: Audience) => ({ tier: a?.tier ?? null, code: a?.code ?? null });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);

function failedLane(lane: AudienceLane, op: ProgramReachOp, e: unknown): AudiencePreviewRow {
  return { lane, op, clientId: null, clientName: "—", tier: null, code: null, to: null, decision: "no", detail: "could not be previewed", reason: `this lane could not be previewed (${errText(e)}); nothing about it is known` };
}

const reminderDecision = (d: string): AudiencePreviewRow["decision"] => (d === "send" ? "send" : d === "wait" ? "wait" : "no");

/** Every lane, read-only. Never throws: a failed lane is one row saying so. */
export async function previewProgramAudience(opts: { now?: Date } = {}): Promise<AudiencePreviewRow[]> {
  const now = opts.now ?? new Date();
  const rows: AudiencePreviewRow[] = [];

  // enrollment → client, for the lanes that name only the enrollment.
  const enrollments = await prisma.contentEnrollment.findMany({ where: { status: { in: ["ACTIVE", "PAUSED"] } }, select: { id: true, clientId: true } });
  const clientOfEnrollment = new Map(enrollments.map((e) => [e.id, e.clientId]));

  // ---- program reminders: all four lanes -------------------------------------
  try {
    const { evaluateReminders } = await import("@/lib/programReminders");
    const r = await evaluateReminders({ dryRun: true, requestedBy: "audience-preview", now });
    // The dry run evaluates on the default policy with the switch OFF; the
    // hourly run then evaluates nothing. So while it is off nothing is "send"
    // (the rows still show who WOULD be reached once it is on).
    const off = !r.enabled;
    const decide = (d: string): AudiencePreviewRow["decision"] => (off ? "no" : reminderDecision(d));
    const why = (reason: string) => (off ? `reminders is off — nothing is sent (with it on: ${reason})` : reason);
    for (const c of r.candidates) {
      if (!c.action && c.decision === "none") continue; // nothing owed this month: no row to show
      rows.push({
        lane: c.lane === "REVIEW" ? "REVIEW" : "PLANNING", op: "reminders", clientId: c.clientId, clientName: c.clientName, ...aud(c.audience), to: c.to,
        decision: decide(c.decision), detail: `${c.action ?? "—"} · ${off ? "switch off" : c.decision}${c.suppressionReason ? ` · ${c.suppressionReason}` : ""}`, reason: why(c.reason),
      });
    }
    for (const a of r.addressLane) {
      rows.push({
        lane: "ADDRESS", op: "reminders", clientId: clientOfEnrollment.get(a.enrollmentId) ?? null, clientName: a.clientName, ...aud(a.audience), to: a.to,
        decision: decide(a.decision), detail: `ADD_ADDRESS · ${off ? "switch off" : a.decision}${a.suppressionReason ? ` · ${a.suppressionReason}` : ""}`, reason: why(a.reason),
      });
    }
    for (const a of r.scriptApprovalLane) {
      rows.push({
        lane: "APPROVE_SCRIPTS", op: "reminders", clientId: clientOfEnrollment.get(a.enrollmentId) ?? null, clientName: a.clientName, ...aud(a.audience), to: a.to,
        decision: decide(a.decision), detail: `APPROVE_SCRIPTS · ${off ? "switch off" : a.decision}${a.suppressionReason ? ` · ${a.suppressionReason}` : ""}`, reason: why(a.reason),
      });
    }
  } catch (e) { rows.push(failedLane("PLANNING", "reminders", e)); }

  // ---- scripts-ready / strategy-ready notices ----------------------------------
  try {
    const { drainShareNotices } = await import("@/lib/scriptShare");
    const r = await drainShareNotices({ dryRun: true, now, max: 200, requestedBy: "audience-preview" });
    for (const n of r.preview) {
      rows.push({
        lane: n.action, op: "script_share_email", clientId: n.clientId, clientName: n.clientName, ...aud(n.audience), to: n.to,
        decision: n.decision === "send" ? "send" : n.decision === "hold" ? "wait" : "no", detail: n.decision, reason: n.reason,
      });
    }
  } catch (e) { rows.push(failedLane("SCRIPTS_READY", "script_share_email", e)); }

  // ---- "the office replied" notices ---------------------------------------------
  try {
    const { sweepProgramMessageNotices } = await import("@/lib/programMessages");
    const r = await sweepProgramMessageNotices({ dryRun: true, now });
    for (const n of r.preview) {
      rows.push({
        lane: "OFFICE_REPLIED", op: "program_message_notice", clientId: n.clientId, clientName: n.clientName, ...aud(n.audience), to: n.to,
        decision: n.decision === "send" ? "send" : "no", detail: n.decision, reason: n.reason,
      });
    }
  } catch (e) { rows.push(failedLane("OFFICE_REPLIED", "program_message_notice", e)); }

  // ---- held portal access (only on the owner's Release) ----------------------------
  try {
    const { previewHeldAccessRelease } = await import("@/lib/portalAccess");
    const p = await previewHeldAccessRelease();
    const { programReachMany } = await import("@/lib/programRollout");
    const reach = await programReachMany("portal_invites", [...p.grant, ...p.stay].map((o) => o.clientId), { now });
    for (const o of p.grant) {
      const d = reach.get(o.clientId);
      rows.push({
        lane: "HELD_ACCESS", op: "portal_invites", clientId: o.clientId, clientName: o.clientName, tier: d?.ok ? d.tier : null, code: d && !d.ok ? d.code : null, to: o.email,
        decision: p.switchOn ? "on_release" : "no", detail: `${o.reason} · granted on Release`, reason: `a ${o.reason === "welcome" ? "paying client's" : "teammate's"} account owed since ${o.since.slice(0, 10)}; Release opens it and sends the welcome`,
      });
    }
    for (const o of p.stay) {
      rows.push({
        lane: "HELD_ACCESS", op: "portal_invites", clientId: o.clientId, clientName: o.clientName, tier: null, code: (reach.get(o.clientId) && !reach.get(o.clientId)!.ok ? (reach.get(o.clientId) as { code: ReachRefusalCode }).code : null), to: o.email,
        decision: "no", detail: `${o.reason} · stays held (${o.code})`, reason: o.why,
      });
    }
  } catch (e) { rows.push(failedLane("HELD_ACCESS", "portal_invites", e)); }

  // ---- automatic sharing (a portal change, no email of its own) --------------------
  try {
    const { sweepAutoShare, AUTO_SHARE_KEY } = await import("@/lib/scriptAutoShare");
    const { isAutomationEnabled } = await import("@/lib/programAutomation");
    // The run's own cap (no max override): "send" names exactly what ONE live
    // run releases.
    const [r, autoOn] = await Promise.all([sweepAutoShare({ dryRun: true, now }), isAutomationEnabled(AUTO_SHARE_KEY).catch(() => false)]);
    if (!("skipped" in r) && r.outcomes.length) {
      const scripts = await prisma.contentScript.findMany({ where: { id: { in: [...new Set(r.outcomes.map((o) => o.scriptId))] } }, select: { id: true, clientId: true } });
      const clientOfScript = new Map(scripts.map((x) => [x.id, x.clientId]));
      const clientIds = [...new Set(scripts.map((x) => x.clientId))];
      const { programReachMany, featureTestOnlyFor } = await import("@/lib/programRollout");
      const reach = await programReachMany("script_auto_share", clientIds, { now, featureTestOnly: await featureTestOnlyFor("script_auto_share") });
      const names = new Map((await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
      for (const o of r.outcomes) {
        const cid = clientOfScript.get(o.scriptId) ?? null;
        const d = cid ? reach.get(cid) : undefined;
        const would = o.wouldShare === true;
        rows.push({
          lane: "AUTO_SHARE", op: "script_auto_share", clientId: cid, clientName: cid ? names.get(cid) ?? cid : "—", tier: d?.ok ? d.tier : null, code: d && !d.ok ? d.code : null, to: null,
          decision: would && autoOn ? "send" : "no",
          detail: would ? (autoOn ? "shared to the portal on the next run" : "eligible, but the switch is off") : "not shared",
          reason: would
            ? autoOn ? `“${o.title}” would be approved and released to their portal` : `“${o.title}” is eligible, but automatic sharing is off — nothing is shared`
            : `“${o.title}”: ${o.reasons.join("; ") || o.error || "not eligible"}`,
        });
      }
    }
  } catch (e) { rows.push(failedLane("AUTO_SHARE", "script_auto_share", e)); }

  // ---- per client: the portal changes the rollout decides ---------------------------
  try {
    const { programAudience } = await import("@/lib/programRollout");
    const { isAutomationEnabled } = await import("@/lib/programAutomation");
    const { layoutForClient } = await import("@/lib/portalLayout");
    const { revisionPolicyFor } = await import("@/lib/reviewWindows");
    const [layoutAud, revAud, carryAud, layoutOn, carryOn] = await Promise.all([
      programAudience("portal_layout_v2", { now }),
      programAudience("revision_policy", { now }),
      programAudience("topic_carryover", { now }),
      isAutomationEnabled("portal_layout_v2").catch(() => false),
      isAutomationEnabled("topic_carryover").catch(() => false),
    ]);
    for (const c of layoutAud.clients) {
      const l = await layoutForClient({ id: c.clientId, name: c.name });
      rows.push({
        lane: "LAYOUT", op: "portal_layout_v2", clientId: c.clientId, clientName: c.name, tier: c.tier, code: c.decision.ok ? null : c.decision.code, to: null,
        decision: l.layout === "v2" ? "send" : "no", detail: `${l.layout} · ${l.why}`,
        reason: l.layout === "v2" ? (l.why === "TEST_CLIENT" ? "a TEST client always sees the new layout" : "the new layout, on their next page load") : !layoutOn ? "today's layout: the new-layout switch is off" : `today's layout: ${c.decision.reason}`,
      });
    }
    for (const c of revAud.clients) {
      const pol = await revisionPolicyFor(c.clientId, now);
      rows.push({
        lane: "REVIEW_DEADLINES", op: "revision_policy", clientId: c.clientId, clientName: c.name, tier: c.tier, code: c.decision.ok ? null : c.decision.code, to: null,
        decision: pol.on ? "send" : "no", detail: pol.on ? `deadlines from ${pol.enabledAt?.toISOString().slice(0, 10) ?? "—"}${pol.autoApprove.on ? " · automatic approval" : ""}` : "no deadlines",
        reason: pol.on ? "reviews opened from that date are held to a deadline" : c.decision.ok ? "review deadlines are switched off" : c.decision.reason,
      });
    }
    for (const c of carryAud.clients) {
      rows.push({
        lane: "TOPIC_CARRYOVER", op: "topic_carryover", clientId: c.clientId, clientName: c.name, tier: c.tier, code: c.decision.ok ? null : c.decision.code, to: null,
        decision: carryOn && c.decision.ok ? "wait" : "no", detail: carryOn ? (c.decision.ok ? "carries on the 1st" : "not carried") : "switch off",
        reason: !carryOn ? "carry-over is switched off" : c.decision.ok ? "unfilmed scripted topics carry into the new month on the 1st (only those scripted after they joined)" : c.decision.reason,
      });
    }
  } catch (e) { rows.push(failedLane("LAYOUT", "portal_layout_v2", e)); }

  const rank = (r: AudiencePreviewRow) => (r.decision === "send" ? 0 : r.decision === "on_release" ? 1 : r.decision === "wait" ? 2 : 3);
  return rows.sort((a, b) => rank(a) - rank(b) || a.clientName.localeCompare(b.clientName) || a.lane.localeCompare(b.lane));
}
