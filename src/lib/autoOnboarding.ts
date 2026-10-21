import "server-only";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { isStaffControlledEmail, isSyntheticClientRow } from "@/lib/testClients";
import { loadProgramRollout } from "@/lib/programRollout";
import { CLOSED_ROLLOUT, clientAllowedOps, type ProgramRollout } from "@/lib/programRolloutCore";
import { strategyAwaits, strategyInForceNo } from "@/lib/strategyAwaiting";
import {
  AUTO_ONBOARD_TOGGLES, autoWelcomeIntentId, dayET, toggleOf, toggleOn,
} from "@/lib/clientOnboardingCore";

// ---------------------------------------------------------------------------
// CLIENT ONBOARDING, DONE FOR THEM (Oct 14 2026).
//
// Jordan, Oct 13: "Can you just automate this and turn everything on when you
// are done? I want a sign-up email to go out and for everything to be
// activated ... I just want everything done for me at this point."
//
// autoOnboardClient walks the seven steps of Settings → Client onboarding for
// ONE client, by calling the same functions the panel's buttons call, so every
// check those make still holds (nothing here writes the rollout, a seat or an
// outbox row itself):
//   2 Strategy   the newest APPROVED version, released if it is not
//                (programOnboarding.releaseStrategyToPortal: the strategy-ready
//                email only through its own switch and the rollout). An
//                unattended run (maybeAutoOnboard) releases only a version
//                Jordan approved: an admin's approval waits for his Release
//                (Oct 21 2026);
//   3/6 Features every toggle in AUTO_ONBOARD_TOGGLES through
//                setOnboardingToggle, never "Share scripts without my approval"
//                (Jordan reviews every script). Bookings is skipped, Kyle
//                booking by hand, while automatic Aryeo booking is not proven;
//   4 Account    the OWNER seat through createOnboardingSeat, at the address a
//                welcome is held for from their payment, else the client's
//                email on file. No email on file: reported, no welcome;
//   5 Welcome    the panel's own composed welcome, through sendOnboardingMessage
//                with the intent auto-welcome-<clientId>, so the outbox's
//                unique key makes a second send impossible. Never when a
//                welcome already went (from the panel, marked sent, from their
//                payment's grant, or an earlier run), and held while the
//                welcome could not work (sign-in emails off);
//   7 Done       marked onboarded once the account exists and the welcome is
//                settled.
// Idempotent: a second run finds every step done and changes nothing.
//
// WHO. ACTIVE programs only. PAUSED / ENDED are skipped. A TEST client is
// skipped unless the caller passes allowTest (a dry test): it needs no
// toggles, its seat must be a staff-controlled address and its welcome goes
// only to Jordan's verified test inbox (the panel's and the outbox's floor).
//
// maybeAutoOnboard is the hook for a program becoming ACTIVE (website signup,
// reactivation, the Aryeo plan sweep), behind the auto_onboarding switch.
// ---------------------------------------------------------------------------

export type AutoStepStatus = "done" | "already" | "would" | "skipped" | "failed";
export type AutoStep = { key: "strategy" | "features" | "account" | "welcome" | "onboarded"; status: AutoStepStatus; detail: string };
export type AutoOnboardReport = {
  clientId: string;
  name: string;
  /** onboarded = every step settled; partial = something needs a person; skipped = not run; would = a dry run. */
  outcome: "onboarded" | "partial" | "skipped" | "would";
  reason: string | null;
  steps: AutoStep[];
  /** Their EXISTING program (the one that holds their strategy, months, scripts and videos): the seat goes on it. */
  enrollmentId: string | null;
  /** The address the OWNER seat uses (or would use), or null. */
  seatEmail: string | null;
  /** Other Client records with the same name or email: Jordan should know (Oct 14 2026). */
  duplicates: string[];
};

export type AutoOnboardOpts = {
  sendWelcome: boolean;
  /** Run for a TEST client too (a dry test). Its welcome still goes only to the verified test inbox. */
  allowTest?: boolean;
  /** Write nothing and send nothing: say what each step would do. */
  dryRun?: boolean;
  byAppUserId?: string | null;
  /** Oct 21 2026: a sweep or a status change, not Jordan's press. An approved
   *  strategy is released only when Jordan approved it; an admin's approval
   *  waits for his Release (content/actions.approveStrategy, the same rule). */
  unattended?: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (e: string | null | undefined): string | null => {
  const v = (e ?? "").trim().toLowerCase();
  return EMAIL_RE.test(v) ? v : null;
};
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

/**
 * Has this client ALREADY been sent a welcome, by any road? The panel's send
 * or Jordan's "marked sent" (the onboarding record), an onboarding welcome in
 * the outbox (any intent, the automatic one included), or the payment grant's
 * own welcome to one of their seats (portal_invite:<membership>:welcome). A
 * failed outbox row has its dedupeKey cleared, so only a welcome that went,
 * or may have gone, counts. Returns how, or null.
 */
export async function welcomeAlreadySent(clientId: string): Promise<string | null> {
  const { welcomeAlreadySentFromOnboarding } = await import("@/lib/clientOnboarding");
  const fromPanel = await welcomeAlreadySentFromOnboarding(clientId);
  if (fromPanel) return fromPanel;
  const seats = await prisma.clientMembership.findMany({ where: { clientId }, select: { id: true } });
  if (seats.length) {
    const { portalWelcomeKey } = await import("@/lib/portalAccess");
    const granted = await prisma.outboxMessage.findFirst({ where: { dedupeKey: { in: seats.map((s) => portalWelcomeKey(s.id)) } }, orderBy: { createdAt: "asc" }, select: { state: true, createdAt: true } });
    if (granted) return `sent with their portal account ${dayET(granted.createdAt.toISOString())} (${granted.state})`;
  }
  return null;
}

/** Normalised for comparing names: lower case, single spaces. */
const nameKey = (n: string | null | undefined) => (n ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Other Client records that look like this client (the same name, or the
 * same email), with their program's status, e.g. "Janice Pigga
 * (janicepigga@..., program ENDED, record ...)". Only reported; the run
 * always uses the record it was given.
 */
export async function duplicateRecordsOf(client: { id: string; name: string; email: string | null }): Promise<string[]> {
  const email = normEmail(client.email);
  const first = nameKey(client.name).split(" ")[0] ?? "";
  const rows = await prisma.client.findMany({
    where: { id: { not: client.id }, OR: [...(first ? [{ name: { contains: first, mode: "insensitive" as const } }] : []), ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : [])] },
    select: { id: true, name: true, email: true },
    take: 50,
  });
  const same = rows.filter((r) => nameKey(r.name) === nameKey(client.name) || (!!email && normEmail(r.email) === email));
  if (!same.length) return [];
  const programs = await prisma.contentEnrollment.findMany({ where: { clientId: { in: same.map((r) => r.id) } }, select: { clientId: true, status: true } });
  return same.map((r) => {
    const st = programs.find((p) => p.clientId === r.id)?.status;
    return `${r.name} (${r.email ?? "no email"}, ${st ? `program ${st}` : "no program"}, record ${r.id})`;
  });
}

/** Welcomes held for this client and address whose program no longer exists (the hold's key names a deleted enrollment). */
async function staleHeldWelcomes(clientId: string, email: string): Promise<{ key: string; enrollmentId: string }[]> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: "portal-access-owed:" } }, select: { key: true, value: true } });
  const mine: { key: string; enrollmentId: string }[] = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as { clientId?: string; enrollmentId?: string; email?: string; reason?: string };
      if (v.clientId === clientId && v.reason === "welcome" && normEmail(v.email) === email && v.enrollmentId) mine.push({ key: r.key, enrollmentId: v.enrollmentId });
    } catch { /* a hand-edited row is not ours to judge */ }
  }
  if (!mine.length) return [];
  const live = new Set((await prisma.contentEnrollment.findMany({ where: { id: { in: mine.map((m) => m.enrollmentId) } }, select: { id: true } })).map((e) => e.id));
  return mine.filter((m) => !live.has(m.enrollmentId));
}

/** Did the owner approve this strategy version? `approvedBy` is the approver's sign-in email. */
async function approvedByOwner(approvedBy: string | null): Promise<boolean> {
  const email = (approvedBy ?? "").trim();
  if (!email.includes("@")) return false;
  return (await prisma.appUser.count({ where: { email: { equals: email, mode: "insensitive" }, role: "OWNER" } })) > 0;
}

/** "their existing program <id> (3 months, 12 scripts, 9 topics)". */
async function existingPortalWords(enrollmentId: string): Promise<string> {
  const [months, scripts, topics] = await Promise.all([
    prisma.contentMonth.count({ where: { enrollmentId } }),
    prisma.contentScript.count({ where: { enrollmentId } }),
    prisma.contentTopic.count({ where: { enrollmentId } }),
  ]);
  return `their existing program ${enrollmentId} (${months} month${months === 1 ? "" : "s"}, ${scripts} script${scripts === 1 ? "" : "s"}, ${topics} topic${topics === 1 ? "" : "s"})`;
}

/** The whole Client onboarding page for ONE client. See the header. */
export async function autoOnboardClient(clientId: string, by: string, opts: AutoOnboardOpts): Promise<AutoOnboardReport> {
  const dry = opts.dryRun === true;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, email: true, backupEmail: true } });
  let enrollmentId: string | null = null;
  let seatEmail: string | null = null;
  let duplicates: string[] = [];
  const report = (outcome: AutoOnboardReport["outcome"], reason: string | null, steps: AutoStep[] = []): AutoOnboardReport => ({ clientId, name: client?.name ?? clientId, outcome, reason, steps, enrollmentId, seatEmail, duplicates });
  if (!client) return report("skipped", "the client no longer exists");
  // THE PORTAL ALREADY BUILT FOR THEM (Jordan, Oct 14 2026: "Make sure that
  // they are signing up for the portals we already have built for them").
  // One program per client record (ContentEnrollment.clientId is unique), so
  // this is the program that holds their strategy, months, topics, scripts
  // and videos; nothing here ever creates a program or a client. Duplicate
  // client records (an older one with an ENDED program) are named in the
  // report and never used.
  duplicates = await duplicateRecordsOf(client);
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { clientId }, select: { id: true, status: true } });
  if (!enrollment) return report("skipped", "no content program");
  enrollmentId = enrollment.id;
  if (enrollment.status !== "ACTIVE") return report("skipped", `the program is ${enrollment.status.toLowerCase()}`);
  const isTest = isSyntheticClientRow(client);
  if (isTest && !opts.allowTest) return report("skipped", "a TEST client (pass allowTest for a test run)");

  const ob = await import("@/lib/clientOnboarding");
  const steps: AutoStep[] = [];
  const step = (s: AutoStep) => { steps.push(s); return s; };

  // ---- 2. strategy ---------------------------------------------------------
  try {
    // Oct 20 2026 (audit D4): "waiting" is the one rule in strategyAwaiting.ts
    // (DRAFT or INTERNAL_REVIEW, newer than the version in force), so a
    // discovery DRAFT is named here the way the Dashboard names it.
    const versions = await prisma.contentStrategyVersion.findMany({ where: { enrollmentId: enrollment.id, status: { in: ["DRAFT", "INTERNAL_REVIEW", "APPROVED"] } }, orderBy: { versionNo: "desc" }, select: { id: true, versionNo: true, status: true, releasedAt: true, approvedBy: true } });
    const approved = versions.find((v) => v.status === "APPROVED") ?? null;
    const inForceNo = strategyInForceNo(versions);
    const waiting = versions.find((v) => strategyAwaits(v, inForceNo));
    const waitingNote = waiting ? ` v${waiting.versionNo} is waiting for your approval (your approval releases it).` : "";
    if (!approved) step({ key: "strategy", status: "skipped", detail: `No approved strategy yet.${waitingNote}` });
    else if (approved.releasedAt) step({ key: "strategy", status: "already", detail: `v${approved.versionNo} is in their portal.${waitingNote}` });
    else if (opts.unattended && !(await approvedByOwner(approved.approvedBy))) step({ key: "strategy", status: "skipped", detail: `v${approved.versionNo} is approved, waiting for Jordan to release it.${waitingNote}` });
    else if (dry) step({ key: "strategy", status: "would", detail: `would release v${approved.versionNo} to their portal (the strategy-ready email only if its switch and the rollout allow it).${waitingNote}` });
    else {
      const { releaseStrategyToPortal } = await import("@/lib/programOnboarding");
      const r = await releaseStrategyToPortal(approved.id, by);
      step({ key: "strategy", status: "done", detail: `v${approved.versionNo}: ${r.message}${waitingNote}` });
    }
  } catch (e) {
    step({ key: "strategy", status: "failed", detail: `Not released: ${errText(e)}` });
  }

  // ---- 3 and 6. what this client gets ---------------------------------------
  if (isTest) {
    step({ key: "features", status: "already", detail: "A TEST client gets everything that is switched on, at your test inbox only." });
  } else {
    const loaded = await loadProgramRollout().catch(() => ({ rollout: { ...CLOSED_ROLLOUT } as ProgramRollout }));
    const had = clientAllowedOps(loaded.rollout, client);
    const turned: string[] = [];
    const already: string[] = [];
    const problems: string[] = [];
    const bookingNote: string[] = [];
    for (const key of AUTO_ONBOARD_TOGGLES) {
      const t = toggleOf(key);
      if (toggleOn(t, had)) { already.push(t.label); continue; }
      if (dry) { turned.push(t.label); continue; }
      const r = await ob.setOnboardingToggle({ clientId, toggle: key, on: true, by });
      if (r.ok && !/was already on/.test(r.message)) turned.push(t.label);
      else if (r.ok) already.push(t.label);
      else if (key === "bookings") bookingNote.push(r.message.replace(/ Nothing was changed\.$/, ""));
      else problems.push(`"${t.label}": ${r.message}`);
    }
    const parts = [
      turned.length ? `${dry ? "would turn on" : "turned on"}: ${turned.join(", ")}` : null,
      already.length ? `already on: ${already.join(", ")}` : null,
      bookingNote.length ? `bookings stay with Kyle (${bookingNote.join("; ")})` : null,
      problems.length ? `NOT turned on: ${problems.join("; ")}` : null,
      "\"Share scripts without my approval\" is never turned on here",
    ].filter(Boolean);
    step({ key: "features", status: problems.length ? "failed" : dry && turned.length ? "would" : turned.length ? "done" : "already", detail: `${parts.join(". ")}.` });
  }

  // ---- 4. the portal account --------------------------------------------------
  let detail = await ob.loadOnboardingDetail(clientId);
  if (!detail) return report("skipped", "no content program", steps);
  const liveOwner = () => detail!.seats.find((s) => !s.revoked && s.role === "OWNER") ?? null;
  let accountOk = false;
  const owner = liveOwner();
  if (owner) {
    accountOk = true;
    seatEmail = owner.email;
    step({ key: "account", status: "already", detail: `Portal account: ${owner.email}, on ${await existingPortalWords(enrollment.id)}.` });
  } else {
    // The email on THIS client record first (never a duplicate record's);
    // a welcome held from their payment ON THIS PROGRAM only when the record
    // has none. A held address that differs is reported and left held.
    const own = normEmail(client.email);
    const held = detail.heldWelcome?.email ?? null;
    const candidates = [own, held, normEmail(client.backupEmail)].filter((x): x is string => !!x);
    const email = isTest ? candidates.find((e) => isStaffControlledEmail(e)) ?? null : own ?? held;
    seatEmail = email;
    const heldNote = held && email && held !== email ? ` A welcome is still held from their payment for ${held} (a different address): it stays held; release it only if that person needs their own account.` : "";
    if (!email) {
      step({ key: "account", status: "failed", detail: isTest ? "No staff-controlled @realtourpilot.com address on this TEST client, so no account was created." : "No email on file. Add one on the client's page; no account was created and no welcome was sent." });
    } else if (dry) {
      step({ key: "account", status: "would", detail: `would create their portal account for ${email} on ${await existingPortalWords(enrollment.id)}${detail.heldWelcome?.email === email ? " (the address their payment's welcome is held for)" : ""}.${heldNote}` });
    } else {
      const r = await ob.createOnboardingSeat({ clientId, email, name: client.name ?? null, by, byAppUserId: opts.byAppUserId ?? null });
      detail = (await ob.loadOnboardingDetail(clientId)) ?? detail;
      // The seat must be on THIS program (loadOnboardingDetail reads seats by its enrollment id).
      accountOk = r.ok && !!liveOwner() && (await prisma.clientMembership.count({ where: { enrollmentId: enrollment.id, clientId, role: "OWNER", revokedAt: null } })) > 0;
      step({ key: "account", status: accountOk ? "done" : "failed", detail: `${r.message}${accountOk ? ` On ${await existingPortalWords(enrollment.id)}.` : ""}${heldNote}` });
    }
  }

  // A welcome held from their payment on a program that NO LONGER EXISTS
  // (Joseph Sutow, Oct 14 2026: his signup's program was folded into the one
  // he already had, and the hold still names the old id). Release would
  // refuse it for ever ("Enrollment not found"); once their account is open
  // on the existing program, for the same address, it is owed nothing more.
  if (seatEmail) {
    const stale = await staleHeldWelcomes(clientId, seatEmail);
    if (stale.length) {
      if (dry) {
        step({ key: "account", status: "would", detail: `would clear ${stale.length} welcome${stale.length === 1 ? "" : "s"} held from their payment on a program that no longer exists (${stale.map((x) => x.enrollmentId).join(", ")}); their account is on the existing program.` });
      } else if (accountOk) {
        await prisma.$transaction([
          prisma.appSetting.deleteMany({ where: { key: { in: stale.map((x) => x.key) } } }),
          prisma.auditLog.create({ data: { actor: by, action: "auto_onboarding_cleared_stale_hold", target: clientId, detail: `Held welcome(s) for ${seatEmail} on program(s) that no longer exist (${stale.map((x) => x.enrollmentId).join(", ")}) cleared: the account is open on ${enrollment.id}.` } }),
        ]);
        step({ key: "account", status: "done", detail: `Cleared ${stale.length} welcome${stale.length === 1 ? "" : "s"} held on a program that no longer exists; their account is on the existing program.` });
      }
    }
  }

  // ---- 5. the welcome (the sign-up email), once --------------------------------
  let welcomeSettled = !opts.sendWelcome;
  if (!opts.sendWelcome) {
    step({ key: "welcome", status: "skipped", detail: "Not asked to send the welcome." });
  } else {
    const already = await welcomeAlreadySent(clientId);
    const w = detail.messages.find((m) => m.key === "welcome") ?? null;
    if (already) {
      welcomeSettled = true;
      step({ key: "welcome", status: "already", detail: `Welcome already ${already}. Not sent again.` });
    } else if (!accountOk && !dry) {
      step({ key: "welcome", status: "skipped", detail: "Not sent: they have no portal account yet." });
    } else if (!detail.portal.signInByEmail && !dry) {
      step({ key: "welcome", status: "skipped", detail: `Held: the welcome tells them to sign in with their email, but ${detail.portal.signInWhyNot ?? "sign-in emails are not reaching them"}.` });
    } else {
      const seatEmail = liveOwner()?.email ?? null;
      const emails = (w?.recipients ?? []).filter((r) => r.channel === "email").map((r) => r.toRef);
      const to = (seatEmail && emails.includes(seatEmail) ? seatEmail : null) ?? emails[0] ?? (dry ? seatEmail ?? normEmail(client.email) : null);
      if (!w || !to) {
        step({ key: "welcome", status: "failed", detail: isTest ? "Not sent: no verified test inbox is on file for this TEST client." : "Not sent: no email address on file it may go to." });
      } else if (dry) {
        const held = !detail.portal.signInByEmail ? ` (held while ${detail.portal.signInWhyNot ?? "sign-in emails are off"})` : "";
        step({ key: "welcome", status: "would", detail: `would email the welcome to ${to}${held}.` });
      } else if (!w.allowed) {
        step({ key: "welcome", status: "failed", detail: `Not sent: ${w.blockedWhy ?? "it is not allowed for this client"}` });
      } else {
        const r = await ob.sendOnboardingMessage({ clientId, message: "welcome", channel: "email", toRef: to, body: w.body.email, intentId: autoWelcomeIntentId(clientId), by });
        welcomeSettled = r.ok;
        step({ key: "welcome", status: r.outcome === "duplicate" ? "already" : r.ok ? "done" : "failed", detail: r.message });
      }
    }
  }

  // ---- 7. done --------------------------------------------------------------------
  if (detail.record.onboardedAt) {
    step({ key: "onboarded", status: "already", detail: `Onboarded ${dayET(detail.record.onboardedAt)}.` });
  } else if (dry) {
    step({ key: "onboarded", status: "would", detail: "would mark them onboarded once the account exists and the welcome is settled." });
  } else if (accountOk && welcomeSettled) {
    const r = await ob.setOnboarded({ clientId, done: true, by });
    step({ key: "onboarded", status: r.ok ? "done" : "failed", detail: r.message });
  } else {
    step({ key: "onboarded", status: "skipped", detail: "Not marked onboarded yet: the account or the welcome still needs a person (above)." });
  }

  if (dry) return report("would", null, steps);
  const settled = steps.find((s) => s.key === "onboarded");
  const complete = settled?.status === "done" || settled?.status === "already";
  return report(complete ? "onboarded" : "partial", complete ? null : "something above needs a person", steps);
}

/** Every ACTIVE, non-TEST program client, one at a time (the page's "Onboard all active clients"). */
export async function autoOnboardAll(by: string, opts: AutoOnboardOpts): Promise<AutoOnboardReport[]> {
  const enrollments = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { clientId: true } });
  const clients = await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } });
  const real = clients.filter((c) => !isSyntheticClientRow(c)).sort((a, b) => a.name.localeCompare(b.name));
  const out: AutoOnboardReport[] = [];
  for (const c of real) {
    try {
      out.push(await autoOnboardClient(c.id, by, { ...opts, allowTest: false }));
    } catch (e) {
      out.push({ clientId: c.id, name: c.name, outcome: "partial", reason: errText(e), steps: [], enrollmentId: null, seatEmail: null, duplicates: [] });
    }
  }
  return out;
}

/** One line per client for a message or a log. */
export function reportLine(r: AutoOnboardReport): string {
  if (r.outcome === "skipped") return `${r.name}: skipped (${r.reason})`;
  const bad = r.steps.filter((s) => s.status === "failed" || (s.status === "skipped" && s.key !== "strategy"));
  const welcome = r.steps.find((s) => s.key === "welcome");
  const head = r.outcome === "onboarded" ? "onboarded" : r.outcome === "would" ? "would be onboarded" : "needs you";
  const dup = r.duplicates.length ? ` · DUPLICATE CLIENT RECORD${r.duplicates.length > 1 ? "S" : ""}: ${r.duplicates.join("; ")}` : "";
  return `${r.name}: ${head}${welcome ? ` · welcome ${welcome.status}` : ""}${bad.length ? ` · ${bad.map((s) => `${s.key}: ${s.detail}`).join(" ")}` : ""}${dup}`;
}

/**
 * THE HOOK (Oct 14 2026): a program just became ACTIVE. Behind the
 * auto_onboarding switch (a missing row is off). Best-effort: never throws,
 * so a signup, a reactivation or the plan sweep is never failed by it. The
 * welcome goes once (see welcomeAlreadySent and the automatic intent).
 */
export async function maybeAutoOnboard(clientId: string, by: string, why: string): Promise<AutoOnboardReport | null> {
  try {
    if (!(await isAutomationEnabled("auto_onboarding"))) return null;
    const r = await autoOnboardClient(clientId, by, { sendWelcome: true, unattended: true });
    console.info(`[auto-onboarding] ${why}: ${reportLine(r)}`);
    if (r.outcome !== "skipped") await prisma.programAutomation.updateMany({ where: { key: "auto_onboarding" }, data: r.outcome === "onboarded" ? { lastRunAt: new Date(), lastError: null, lastErrorAt: null } : { lastRunAt: new Date(), lastError: reportLine(r).slice(0, 2000), lastErrorAt: new Date() } }).catch(() => {});
    return r;
  } catch (e) {
    console.error(`[auto-onboarding] ${why}: ${clientId} failed`, e);
    await prisma.programAutomation.updateMany({ where: { key: "auto_onboarding" }, data: { lastRunAt: new Date(), lastError: `${clientId}: ${errText(e)}`, lastErrorAt: new Date() } }).catch(() => {});
    return null;
  }
}
