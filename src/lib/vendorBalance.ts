import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSetting, putSetting } from "@/lib/settings";
import { etAt, etDayKey } from "@/lib/datetime";
import { finishedPhotos } from "@/lib/photoCount";
import { slugForName } from "@/lib/assignees";

// ---------------------------------------------------------------------------
// THE AUTOHDR BALANCE (unified handoff §10, AU-20 / J1, Sep 26 2026).
//
// What can be known, and what cannot. AutoHDR's credit balance cannot be READ
// by the hub: there is no AutoHDR connection at all, and nothing verifies that
// AutoHDR offers a balance endpoint. The exact missing operation is "read the
// current credit balance for the account" — that is the blocker, not a generic
// "needs an API". So the balance on screen is only ever one of:
//   · a READING a person typed in (Kyle, every Monday — Jordan, Sep 25),
//   · the finished photos processed since that reading, labelled ESTIMATE,
//   · the last AutoHDR top-up seen in the bank feed or QuickBooks,
//   · AutoHDR's own warning emails, logged owner-only and turned into ONE task
//     a day for Jordan, who is the one person who tops up.
//
// Jordan's answers (Sep 25): Kyle checks on Mondays; Jordan tops up; there is
// NO low-credit threshold until he names one, so until then nothing compares a
// balance to anything. No code here — or anywhere — buys credits.
//
// readAutohdrBalance() is the seam an official balance read would slot into as
// source "api". It returns null today, and it says so.
// ---------------------------------------------------------------------------

export const AUTOHDR_KEY = "autohdr";
const SETTINGS_KEY = "vendor_balance:autohdr";

export type VendorBalanceSettings = {
  /** Who gets the weekly check. Jordan, Sep 25: Kyle. null = no weekly task. */
  checkOwnerKey: string | null;
  /** ET weekday of the check, 0 = Sunday. Jordan, Sep 25: Monday. */
  checkWeekday: number;
  /** Alert below this many credits. null until Jordan names one (Sep 25). */
  thresholdCredits: number | null;
  /** …or below this many dollars. null until Jordan names one. */
  thresholdDollars: number | null;
  /** Credits one finished photo costs. Unknown until Jordan says — the
   *  estimate is then shown in photos only, never converted. */
  creditsPerPhoto: number | null;
};

export const DEFAULT_VENDOR_BALANCE: VendorBalanceSettings = {
  checkOwnerKey: "kyle",
  checkWeekday: 1,
  thresholdCredits: null,
  thresholdDollars: null,
  creditsPerPhoto: null,
};

const posNum = (v: unknown, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max ? v : null;

export async function vendorBalanceSettings(): Promise<VendorBalanceSettings> {
  const r = await getSetting<VendorBalanceSettings>(SETTINGS_KEY, DEFAULT_VENDOR_BALANCE);
  return {
    checkOwnerKey: typeof r.checkOwnerKey === "string" && /^[a-z0-9_]{2,40}$/.test(r.checkOwnerKey) ? r.checkOwnerKey : r.checkOwnerKey === null ? null : DEFAULT_VENDOR_BALANCE.checkOwnerKey,
    checkWeekday: Number.isInteger(r.checkWeekday) && r.checkWeekday >= 0 && r.checkWeekday <= 6 ? r.checkWeekday : DEFAULT_VENDOR_BALANCE.checkWeekday,
    thresholdCredits: posNum(r.thresholdCredits, 1_000_000),
    thresholdDollars: posNum(r.thresholdDollars, 100_000),
    creditsPerPhoto: posNum(r.creditsPerPhoto, 1_000),
  };
}

export async function saveVendorBalanceSettings(next: Partial<VendorBalanceSettings>, updatedBy: string | null): Promise<VendorBalanceSettings> {
  const cur = await vendorBalanceSettings();
  const merged: VendorBalanceSettings = { ...cur, ...next };
  await putSetting(SETTINGS_KEY, merged, updatedBy);
  return vendorBalanceSettings();
}

/**
 * THE SEAM. An official AutoHDR balance read would return a reading here
 * (source "api"). None is verified — so null, and every caller treats null as
 * "not connected", never as zero credits.
 */
export async function readAutohdrBalance(): Promise<{ credits: number | null; dollars: number | null; observedAt: Date } | null> {
  return null;
}

// ---- readings ---------------------------------------------------------------

export type ReadingInput = {
  credits?: number | null;
  dollars?: number | null;
  note?: string | null;
  recordedBy: string;
  observedAt?: Date;
  source?: "manual" | "vendor-email" | "bank-topup";
};

/** A person's reading off the AutoHDR account. Closes the week's check task. */
export async function recordBalanceReading(input: ReadingInput): Promise<{ ok: boolean; message: string; id?: string }> {
  const credits = input.credits == null ? null : Math.round(Number(input.credits));
  const dollars = input.dollars == null ? null : Math.round(Number(input.dollars) * 100) / 100;
  if (credits === null && dollars === null) return { ok: false, message: "Enter the credits left, the dollar balance, or both." };
  if ((credits !== null && (!Number.isFinite(credits) || credits < 0 || credits > 10_000_000)) || (dollars !== null && (!Number.isFinite(dollars) || dollars < 0 || dollars > 1_000_000))) {
    return { ok: false, message: "That balance doesn't look right — check the number." };
  }
  const observedAt = input.observedAt ?? new Date();
  const row = await prisma.vendorBalanceReading.create({
    data: {
      vendorKey: AUTOHDR_KEY,
      observedAt,
      credits,
      dollars,
      source: input.source ?? "manual",
      recordedBy: input.recordedBy,
      note: input.note?.trim().slice(0, 500) || null,
    },
    select: { id: true },
  });
  await prisma.smartTask.updateMany({
    where: { dedupeKey: { startsWith: "autohdr-balance-check-" }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "COMPLETED", completedAt: new Date(), sourceDetail: `Reading recorded by ${input.recordedBy}` },
  });
  return { ok: true, message: "Balance recorded.", id: row.id };
}

// ---- the view ---------------------------------------------------------------

export type TopUpSeen = { at: Date; amount: number; source: "bank" | "quickbooks"; label: string };

/** The newest AutoHDR payment in the bank feed or QuickBooks — what Jordan
 *  last put on the account. Read from rows the hub already holds. */
export async function lastAutohdrTopUp(): Promise<TopUpSeen | null> {
  const [plaid, qbo] = await Promise.all([
    prisma.plaidTransaction
      .findFirst({
        // Plaid's sign: POSITIVE is money out of the account.
        where: {
          pending: false,
          amount: { gt: 0 },
          OR: [
            { name: { contains: "autohdr", mode: "insensitive" } },
            { name: { contains: "auto hdr", mode: "insensitive" } },
            { merchantName: { contains: "autohdr", mode: "insensitive" } },
            { merchantName: { contains: "auto hdr", mode: "insensitive" } },
          ],
        },
        orderBy: { date: "desc" },
        select: { date: true, amount: true, name: true, merchantName: true },
      })
      .catch(() => null),
    prisma.qboTransaction
      .findFirst({
        where: {
          type: { in: ["Purchase", "Bill", "BillPayment", "Expense"] },
          OR: [
            { customerName: { contains: "autohdr", mode: "insensitive" } },
            { customerName: { contains: "auto hdr", mode: "insensitive" } },
            { memo: { contains: "autohdr", mode: "insensitive" } },
          ],
        },
        orderBy: { txnDate: "desc" },
        select: { txnDate: true, amount: true, customerName: true, memo: true },
      })
      .catch(() => null),
  ]);
  const a: TopUpSeen | null = plaid ? { at: plaid.date, amount: Math.abs(plaid.amount), source: "bank", label: plaid.merchantName || plaid.name || "AutoHDR" } : null;
  const b: TopUpSeen | null = qbo ? { at: qbo.txnDate, amount: Math.abs(qbo.amount), source: "quickbooks", label: qbo.customerName || "AutoHDR" } : null;
  if (!a) return b;
  if (!b) return a;
  return a.at >= b.at ? a : b;
}

export type AutohdrBalanceView = {
  api: { connected: false; note: string };
  lastReading: { observedAt: Date; credits: number | null; dollars: number | null; source: string; recordedBy: string; note: string | null } | null;
  /** Photos AutoHDR should have processed since the reading. An ESTIMATE:
   *  (brackets ÷ 5) + drone singles off each job's counted raws. */
  since: { finishedPhotos: number; jobs: number; uncountedJobs: number } | null;
  /** Credits used since the reading, only when credits-per-photo is known. */
  estimatedCreditsUsed: number | null;
  estimatedCreditsLeft: number | null;
  /** OWNER-only (see autohdrBalanceView's `money`); null for anyone else. */
  lastTopUp: TopUpSeen | null;
  threshold: { credits: number | null; dollars: number | null } | null;
  /** null = no threshold configured, so no comparison is made at all. */
  low: boolean | null;
  settings: VendorBalanceSettings;
  openWarnings: number;
};

/**
 * `money` (Sep 26 2026 review): the last top-up is the OWNER's payment, read
 * off his bank feed (no business/personal filter — it can be his personal
 * account) and QuickBooks. The page Kyle records his Monday reading on is open
 * to ADMIN, and an admin gets full ops and NO money (access.ts canSeeMoney),
 * so the figure is opt-in: without `money: true` the bank and the books are
 * not even read and lastTopUp is null. A caller passes canSeeMoney(role).
 */
export async function autohdrBalanceView(now = new Date(), opts: { money?: boolean } = {}): Promise<AutohdrBalanceView> {
  const [settings, reading, lastTopUp, api, openWarnings] = await Promise.all([
    vendorBalanceSettings(),
    prisma.vendorBalanceReading.findFirst({ where: { vendorKey: AUTOHDR_KEY }, orderBy: { observedAt: "desc" } }),
    opts.money === true ? lastAutohdrTopUp() : Promise.resolve(null),
    readAutohdrBalance(),
    prisma.smartTask.count({ where: { dedupeKey: { startsWith: "autohdr-balance-mail-" }, status: { notIn: ["COMPLETED", "CANCELLED"] } } }).catch(() => 0),
  ]);
  const last = api
    ? { observedAt: api.observedAt, credits: api.credits, dollars: api.dollars, source: "api", recordedBy: "api", note: null }
    : reading
      ? { observedAt: reading.observedAt, credits: reading.credits, dollars: reading.dollars, source: reading.source, recordedBy: reading.recordedBy, note: reading.note }
      : null;

  let since: AutohdrBalanceView["since"] = null;
  if (last) {
    const jobs = await prisma.project.findMany({
      where: { shootDate: { gte: last.observedAt, lte: now }, status: { not: "CANCELLED" } },
      select: { rawPhotoCount: true, dronePhotoCount: true, deliverables: { where: { removedFromOrderAt: null, type: { in: ["PHOTOS", "DRONE"] } }, select: { id: true } } },
    });
    let photos = 0, counted = 0, uncounted = 0;
    for (const j of jobs) {
      if (j.rawPhotoCount != null) {
        photos += finishedPhotos(j.rawPhotoCount, j.dronePhotoCount ?? 0);
        counted++;
      } else if (j.deliverables.length > 0) {
        uncounted++; // a photo job not counted yet: unknown, never zero
      }
    }
    since = { finishedPhotos: photos, jobs: counted, uncountedJobs: uncounted };
  }
  const estimatedCreditsUsed = since && settings.creditsPerPhoto != null ? Math.round(since.finishedPhotos * settings.creditsPerPhoto) : null;
  const estimatedCreditsLeft = last?.credits != null && estimatedCreditsUsed != null ? last.credits - estimatedCreditsUsed : null;
  const threshold = settings.thresholdCredits != null || settings.thresholdDollars != null
    ? { credits: settings.thresholdCredits, dollars: settings.thresholdDollars }
    : null;
  let low: boolean | null = null;
  if (threshold && last) {
    const byCredits = threshold.credits != null ? (estimatedCreditsLeft ?? last.credits) : null;
    low =
      (threshold.credits != null && byCredits != null && byCredits < threshold.credits) ||
      (threshold.dollars != null && last.dollars != null && last.dollars < threshold.dollars);
  }
  return {
    api: { connected: false, note: "Not connected — AutoHDR's balance can't be read by the hub (no verified balance endpoint)." },
    lastReading: last,
    since,
    estimatedCreditsUsed,
    estimatedCreditsLeft,
    lastTopUp,
    threshold,
    low,
    settings,
    openWarnings,
  };
}

// ---- tasks --------------------------------------------------------------------

async function personFor(key: string): Promise<{ id: string; key: string } | null> {
  const people = await prisma.teamMember.findMany({ where: { active: true }, select: { id: true, name: true } });
  const hit = people.find((m) => slugForName(m.name) === key);
  return hit ? { id: hit.id, key } : null;
}

/** Jordan: his roster row, found through the OWNER login rather than a name. */
async function ownerPerson(): Promise<{ id: string | null; key: string }> {
  const login = await prisma.appUser.findFirst({ where: { role: "OWNER", status: "ACTIVE", teamMemberId: { not: null } }, select: { teamMemberId: true } });
  if (login?.teamMemberId) {
    const tm = await prisma.teamMember.findUnique({ where: { id: login.teamMemberId }, select: { id: true, name: true } });
    if (tm) return { id: tm.id, key: slugForName(tm.name) };
  }
  const byName = await prisma.teamMember.findFirst({ where: { name: { startsWith: "Jordan" }, active: true }, select: { id: true, name: true } });
  return byName ? { id: byName.id, key: slugForName(byName.name) } : { id: null, key: "jordan" };
}

const weekdayET = (d: Date) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(d));

/**
 * Kyle's Monday check (Jordan, Sep 25). One task per check day, due 5 PM ET,
 * skipped when a reading already landed that day. No owner set = no task.
 */
export async function ensureWeeklyBalanceCheck(now = new Date()): Promise<{ created: boolean; reason: string }> {
  const s = await vendorBalanceSettings();
  if (!s.checkOwnerKey) return { created: false, reason: "no check owner set" };
  if (weekdayET(now) !== s.checkWeekday) return { created: false, reason: "not the check day" };
  const day = etDayKey(now);
  const dayStart = etAt(day, 0);
  const already = await prisma.vendorBalanceReading.findFirst({ where: { vendorKey: AUTOHDR_KEY, observedAt: { gte: dayStart } }, select: { id: true } });
  if (already) return { created: false, reason: "a reading already landed today" };
  const who = await personFor(s.checkOwnerKey);
  const dedupeKey = `autohdr-balance-check-${day}`;
  if (await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } })) return { created: false, reason: "already filed" };
  try {
    await prisma.smartTask.create({
      data: {
        taskType: "vendor_balance_check",
        title: "Check the AutoHDR credit balance",
        summary: "Weekly check: log in to AutoHDR, note the credits (and dollar balance) left, and record it on Settings → AutoHDR balance. Jordan tops up — the hub never buys credits. Recording the reading closes this task.",
        reasonCreated: "Weekly AutoHDR balance check (Jordan, Sep 25: Kyle checks on Mondays)",
        source: "system",
        sourceDetail: "/settings/autohdr",
        priority: "MEDIUM",
        dueAt: etAt(day, 17),
        assignedKey: s.checkOwnerKey,
        ownerId: who?.id ?? null,
        dedupeKey,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { created: false, reason: "already filed" };
    throw e;
  }
  return { created: true, reason: "filed" };
}

const BALANCE_MAIL_RE = /credit|balance|insufficient|top.?up|out of|running low|payment (?:failed|declined)|card (?:failed|declined)/i;
const DONE_MAIL_RE = /\b(complete[d]?|ready|finished|processed|delivered)\b/i;

export function isAutohdrDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return d === "autohdr.com" || d.endsWith(".autohdr.com");
}

/**
 * Every AutoHDR email, from the Gmail sync. Until Sep 26 these were dropped
 * before they were even logged (vendor mail, "never a lead") — so a low-credit
 * warning reached nobody and a finished-batch notice proved nothing. Now:
 *   · logged to comms memory OWNER-only (billing mail can carry card detail);
 *   · a credit/payment warning → ONE task per ET day, for Jordan;
 *   · a "job complete" notice → attached to the one batch whose street it names.
 * Never a lead, never a client task, never a reply-queue row.
 */
export async function handleAutohdrMail(input: {
  externalId: string;
  gmailId: string;
  subject: string;
  body: string;
  fromEmail: string;
  occurredAt?: Date;
  now?: Date;
}): Promise<{ logged: boolean; tasksCreated: number; batchId: string | null }> {
  const now = input.now ?? new Date();
  const { logComm } = await import("@/lib/commLog");
  const logged = await logComm({
    channel: "email",
    direction: "in",
    minRole: "OWNER",
    contactName: "AutoHDR",
    subject: input.subject,
    body: input.body || input.subject,
    occurredAt: input.occurredAt ?? now,
    source: "gmail-vendor",
    externalId: input.externalId,
  });
  const text = `${input.subject}\n${input.body}`;
  let tasksCreated = 0;
  let batchId: string | null = null;
  if (BALANCE_MAIL_RE.test(text)) {
    const day = etDayKey(now);
    const dedupeKey = `autohdr-balance-mail-${day}`;
    const exists = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } });
    if (!exists) {
      const owner = await ownerPerson();
      try {
        await prisma.smartTask.create({
          data: {
            taskType: "vendor_balance",
            title: "AutoHDR emailed about credits or payment",
            summary: `AutoHDR sent a credit or payment email ("${input.subject.slice(0, 120)}"). Check the AutoHDR account and top up if it needs it — the hub never buys credits. The email is in comms memory (owner-only); record the balance on Settings → AutoHDR balance.`.slice(0, 500),
            reasonCreated: "AutoHDR credit/balance/payment email",
            source: "system",
            sourceDetail: input.externalId.slice(0, 190),
            priority: "HIGH",
            dueAt: etAt(day, 17),
            assignedKey: owner.key,
            ownerId: owner.id,
            dedupeKey,
          },
        });
        tasksCreated = 1;
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      }
    }
  } else if (DONE_MAIL_RE.test(text)) {
    const { attachVendorEmail } = await import("@/lib/photoEditBatches");
    batchId = await attachVendorEmail({ gmailId: input.gmailId, text, now }).catch(() => null);
  }
  return { logged, tasksCreated, batchId };
}
