import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getSetting, putSetting } from "@/lib/settings";
import { getSecret } from "@/lib/integrations/connections";
import { etMonthDay, etDayKey } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// RTP-28 (Sep 16 2026). This module is now the ONE place that answers three
// questions about inbound webhooks, so every receiver and the Connections
// screen say the same thing:
//
//   1. is this lane actually delivering?      (webhookLaneHealth)
//   2. what do we do with a post we can't verify?  (webhookEnforced / refuseWebhook)
//   3. what still needs a human?              (retryFailedWebhooks / unresolvedWebhookFailures)
//
// Written against a LIVE incident, not a theory: Aryeo's real-time delivery has
// been dead since Tue Sep 8 10:20am ET — 36 signature rejections that morning
// and then nothing for eight days — while gmail, openphone, slack and scripting
// kept arriving. The hourly reconcile covered it, so every screen stayed green.
// The rule this module encodes: a lane that stops must become LOUD and LEGIBLE,
// and nothing here may quietly loosen a check to make a red light go away.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WHO POSTS TO US
// ---------------------------------------------------------------------------

/** Receivers that accept an HTTP POST from outside. `gmail` is NOT one — it's a
 *  poller that writes WebhookEvent rows — but it IS a delivery lane, so the
 *  health strip carries it and the enforcement column reads "n/a". */
export const WEBHOOK_RECEIVERS = ["aryeo", "openphone", "scripting", "slack"] as const;
export type WebhookReceiver = (typeof WEBHOOK_RECEIVERS)[number];
export const WEBHOOK_LANES = [...WEBHOOK_RECEIVERS, "gmail"] as const;

type LaneCopy = {
  name: string;
  /** What the office loses while this lane is quiet — the honest consequence. */
  cover: string;
  /** The fix when the silence started with bounced signatures. */
  fixAfterRejections: string;
  /** The fix when it just went quiet. */
  fix: string;
};

const LANE: Record<string, LaneCopy> = {
  aryeo: {
    name: "Aryeo",
    cover: "the hourly sync is covering, media updates arrive up to an hour late",
    fixAfterRejections: "Re-paste the signing secret from Aryeo.",
    fix: "Check the webhook subscription in Aryeo (Group Settings → Developers → Webhooks) still points at this hub.",
  },
  openphone: {
    name: "OpenPhone",
    cover: "nothing backfills texts and calls, so anything sent meanwhile is missing from the hub",
    fixAfterRejections: "Press “Enable real-time” on the OpenPhone card to re-register the hook with a fresh token.",
    fix: "Press “Enable real-time” on the OpenPhone card to re-register the hook.",
  },
  scripting: {
    name: "Script Studio",
    cover: "script and hook changes only appear when someone opens the job",
    fixAfterRejections: "Re-copy HUB_WEBHOOK_SECRET from Script Studio into SCRIPTING_WEBHOOK_SECRET.",
    fix: "Check the hub webhook is still enabled in Script Studio.",
  },
  slack: {
    name: "Slack",
    cover: "messages posted in Slack stop reaching the hub",
    fixAfterRejections: "Re-install the Ops Hub Slack app and re-copy its signing secret.",
    fix: "Re-install the Ops Hub Slack app.",
  },
  gmail: {
    name: "Gmail",
    cover: "new email stops feeding comms and the morning brief",
    fixAfterRejections: "Reconnect the mailbox on this page.",
    fix: "Reconnect the mailbox on this page.",
  },
};

export const laneName = (provider: string) => LANE[provider]?.name ?? provider;

// ---------------------------------------------------------------------------
// ENFORCEMENT — a coordinated cutover, never a flip
//
// The ticket asks every receiver that accepts unsigned posts when its secret is
// absent to fail closed. Flipping that in code would have severed whichever
// lane was mid-misconfiguration — which is EXACTLY what happened to Aryeo on
// Sep 8. So enforcement is a per-provider setting whose default is the CURRENT
// behaviour of that receiver, the office flips it on this screen, and a refusal
// is recorded as a REJECTED WebhookEvent with a reason instead of vanishing
// into a 401 nobody sees.
//
// DEFAULTS BELOW = what each receiver does TODAY at HEAD. Changing a default
// here changes production behaviour without anyone pressing anything; don't.
// ---------------------------------------------------------------------------

export const ENFORCE_DEFAULT: Record<string, boolean> = {
  // src/app/api/webhooks/aryeo/route.ts — `const unsigned = !secret` then accepts.
  aryeo: false,
  // src/lib/integrations/openphone.ts openPhoneRequestAuthorized — `if (!expected) return { ok: true, unsigned: true }`.
  openphone: false,
  // src/app/api/webhooks/scripting/route.ts — `if (secret) {…}` with no else.
  // Its secret is set locally but PRODUCTION CONFIGURATION IS UNKNOWN from here
  // (it's a Vercel env var, not a Connection row we can read), so this one stays
  // on the current default until Jordan says the Vercel value is set. Turning it
  // on blind would silence Script Studio the way Sep 8 silenced Aryeo.
  scripting: false,
  // src/app/api/webhooks/slack/route.ts:14 — `if (!SIGNING_SECRET) return false`.
  // Already fail-closed. Listed so the office can SEE that, not to change it.
  slack: true,
};

/** Providers whose enforcement the office may actually change. Slack is already
 *  fail-closed in code and there is nothing to loosen; gmail is not a receiver. */
export const ENFORCE_TOGGLEABLE: readonly string[] = ["aryeo", "openphone", "scripting"];

const enforceKey = (provider: string) => `webhook-enforce:${provider}`;

/** Does this receiver refuse a post it cannot verify? Defaults to the receiver's
 *  behaviour at HEAD, so an untouched hub behaves exactly as it does today. */
export async function webhookEnforced(provider: string): Promise<boolean> {
  const fallback = { enforce: ENFORCE_DEFAULT[provider] ?? false };
  try {
    const row = await getSetting<{ enforce: boolean }>(enforceKey(provider), fallback);
    return Boolean(row.enforce);
  } catch {
    return fallback.enforce; // a settings read must never change what a receiver does
  }
}

/** Set by the office on /connections. `by` is the signed-in email, recorded on
 *  the AppSetting row so a cutover is attributable. */
export async function setWebhookEnforced(provider: string, enforce: boolean, by?: string | null): Promise<void> {
  await putSetting(enforceKey(provider), { enforce }, by ?? null);
}

async function enforcedAll(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const p of WEBHOOK_LANES) out[p] = p === "gmail" ? false : await webhookEnforced(p);
  return out;
}

// ---------------------------------------------------------------------------
// REFUSALS — the exact words, in one place
//
// These are stored on the REJECTED row and shown on the (owner-only) Connections
// strip. They are deliberately NOT returned in the 401 body: a refused post is
// by definition unauthenticated, and "no signing secret is saved" or "the app
// secret it was encrypted with has changed" tells whoever guessed the URL how
// the door is currently hung. The caller gets a bare "Unverified"; the sentence
// goes where the office can act on it (RTP-28 review, Sep 16).
// ---------------------------------------------------------------------------

export const REFUSAL_NO_SECRET =
  "Refused. This receiver is set to verify every post and no signing secret is saved for it, so nothing was read and nothing was changed. Save the secret on Connections, or switch this provider back to “accept unsigned” there.";

export const REFUSAL_BAD_SIGNATURE =
  "Refused. The signature on this post did not match the saved signing secret, so nothing was read and nothing was changed. Test the secret on Connections before saving a new one.";

export const REFUSAL_UNREADABLE_SECRET =
  "Refused. A signing secret is stored for this receiver but the hub cannot read it — the app secret it was encrypted with has changed — so nothing was read and nothing was changed. Re-save the signing secret on Connections.";

export type RefusalCode = "no-secret" | "bad-signature" | "unreadable-secret";

const REFUSAL_TEXT: Record<RefusalCode, string> = {
  "no-secret": REFUSAL_NO_SECRET,
  "bad-signature": REFUSAL_BAD_SIGNATURE,
  "unreadable-secret": REFUSAL_UNREADABLE_SECRET,
};

export const refusalText = (code: RefusalCode) => REFUSAL_TEXT[code];

/** The same fact in a few words, for a line in the health strip. The long
 *  version above is what the caller was told and what the row records; this is
 *  what someone scanning the page needs. */
const REFUSAL_LABEL: Record<RefusalCode, string> = {
  "no-secret": "Refused — no signing secret is saved and this receiver is set to verify.",
  "bad-signature": "The signature didn’t match the saved secret.",
  "unreadable-secret": "Refused — a signing secret is stored but the hub can’t decrypt it.",
};

/** What we keep about a refused post. Stored as JSON in WebhookEvent.error.
 *  `sig` is the digest the CALLER presented — a MAC over a body we already
 *  store, not a secret of ours — and it is what makes "test a secret against the
 *  last rejected payload" possible without calling the provider. The UI only
 *  ever shows a short prefix of it. */
export type RejectionDetail = {
  v: 1;
  code: RefusalCode;
  reason: string;
  /** Which header carried the signature, so a header-name mismatch is visible. */
  header?: string | null;
  sig?: string | null;
  /** Bytes as received vs bytes we kept — a replay test needs them equal. */
  bodyBytes?: number;
  storedBytes?: number;
};

/** How much of a refused body we keep. Big enough that a real Aryeo order
 *  payload replays byte-for-byte (the old 2,000-char slice truncated all 36 of
 *  the Sep 8 rejections, which is why none of them can be replayed today). */
export const REJECTED_BODY_CAP = 12000;

/** How many refusals in an hour still earn a stored body. Past this we keep the
 *  row (the count is the signal) and drop the bytes: every one of these rows is
 *  written for an UNAUTHENTICATED post, so the payload is attacker-controlled
 *  and the endpoint is open to anyone who guessed the URL. A handful of copies
 *  diagnoses a misconfiguration; ten thousand is just storage someone else
 *  chose to spend (RTP-28 review, Sep 16). */
export const REJECTED_BODY_BURST = 20;

export function decodeRejection(error: string | null | undefined): RejectionDetail | null {
  if (!error || !error.startsWith("{")) return null;
  try {
    const d = JSON.parse(error) as RejectionDetail;
    return d && d.v === 1 && d.code ? d : null;
  } catch {
    return null;
  }
}

/** One readable sentence for a REJECTED row, legacy rows included. The 36 Sep 8
 *  rejections were written before receivers recorded a reason at all — say that
 *  plainly rather than inventing one. */
export function rejectionSentence(error: string | null | undefined): string {
  const d = decodeRejection(error);
  if (d) {
    const bits: string[] = [REFUSAL_LABEL[d.code] ?? d.reason];
    if (d.header) bits.push(`signature header “${d.header}”`);
    if (d.bodyBytes !== undefined && d.storedBytes !== undefined && d.storedBytes < d.bodyBytes) {
      bits.push(`body ${d.bodyBytes} bytes, only ${d.storedBytes} kept`);
    }
    return bits.join(" · ");
  }
  if (error && !error.startsWith("UNSIGNED")) return error.slice(0, 200);
  return "Signature did not match the saved secret. (Recorded before the hub kept the reason — the next rejection will say which header and how long the digest was.)";
}

/** Record a refused post and alert if they start piling up. Best-effort by
 *  design: the 401 goes out whatever happens here. */
export async function refuseWebhook(
  provider: string,
  args: { code: RefusalCode; rawBody?: string; header?: string | null; sig?: string | null },
): Promise<void> {
  const raw = args.rawBody ?? "";
  let stored = raw.slice(0, REJECTED_BODY_CAP);
  try {
    const recent = await prisma.webhookEvent.count({
      where: { provider, status: "REJECTED", createdAt: { gt: new Date(Date.now() - 3600_000) } },
    });
    // Past the burst, keep the row and drop the body. storedBytes then reads 0,
    // which is what stops the replay tester signing the wrong bytes.
    if (recent >= REJECTED_BODY_BURST) stored = "";
  } catch {
    /* can't count — keep the body: a diagnosis is worth more than the bytes */
  }
  const detail: RejectionDetail = {
    v: 1,
    code: args.code,
    reason: refusalText(args.code),
    header: args.header ?? null,
    sig: args.sig ? args.sig.slice(0, 200) : null,
    bodyBytes: Buffer.byteLength(raw, "utf8"),
    storedBytes: Buffer.byteLength(stored, "utf8"),
  };
  try {
    await prisma.webhookEvent.create({
      data: {
        provider,
        eventType: "signature.rejected",
        status: "REJECTED",
        error: JSON.stringify(detail),
        payload: stored || "{}",
      },
    });
    const { alertWebhookRejections } = await import("@/lib/notify");
    await alertWebhookRejections(provider);
  } catch {
    /* never let bookkeeping block a refusal */
  }
}

/** The check every receiver makes when it has NO usable secret: may it still
 *  accept? Returns the refusal code when it may not. The extra Connection read
 *  only happens on this (rare) path, and it is what tells "never configured"
 *  apart from "encrypted with an APP_SECRET that has since changed" — the one
 *  fail-open the audit found genuinely live today. */
export async function gateMissingSecret(
  provider: string,
  connectionProvider: string,
): Promise<{ allow: true } | { allow: false; code: RefusalCode }> {
  if (!(await webhookEnforced(provider))) return { allow: true };
  let stored = false;
  try {
    const row = await prisma.connection.findUnique({ where: { provider: connectionProvider }, select: { secretEncrypted: true } });
    stored = Boolean(row?.secretEncrypted);
  } catch {
    /* unknown — fall through to the plainer reason */
  }
  return { allow: false, code: stored ? "unreadable-secret" : "no-secret" };
}

// ---------------------------------------------------------------------------
// TEST A SECRET WITHOUT CALLING THE PROVIDER
//
// The Sep 8 cutover failed because a secret was saved and then believed. This
// replays a stored rejected body against a CANDIDATE secret and says whether it
// would have been accepted — no request to Aryeo, no write, and the candidate is
// never stored or echoed back.
// ---------------------------------------------------------------------------

/** Can this refused row be replayed against a candidate secret? It needs the
 *  digest the caller presented AND the body byte-for-byte: a truncated body (the
 *  old 2,000-char slice) or one dropped by the burst guard signs to something the
 *  provider never sent, and a "does not match" on those bytes would be a lie. */
function isReplayable(d: RejectionDetail | null): boolean {
  return Boolean(d?.sig) && (d?.storedBytes ?? 0) > 0 && (d?.bodyBytes ?? 0) === (d?.storedBytes ?? -1);
}

export type SignatureTest =
  | { ok: true; matched: "hex" | "base64"; when: string; header: string | null }
  | { ok: false; kind: "no-match"; when: string; header: string | null }
  | { ok: false; kind: "nothing-to-test"; note: string };

export async function testSecretAgainstLastRejection(provider: string, candidate: string): Promise<SignatureTest> {
  const [rows, held] = await Promise.all([
    prisma.webhookEvent.findMany({
      where: { provider, status: "REJECTED" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { createdAt: true, payload: true, error: true },
    }),
    prisma.webhookEvent.count({ where: { provider, status: "REJECTED" } }),
  ]);
  const usable = rows.map((r) => ({ row: r, d: decodeRejection(r.error) })).find((x) => x.row.payload && isReplayable(x.d));
  if (!usable || !usable.d?.sig) {
    return {
      ok: false,
      kind: "nothing-to-test",
      note: held
        ? `The ${held} refused ${laneName(provider)} post${held === 1 ? "" : "s"} we still hold ${held === 1 ? "was" : "were"} recorded before the hub kept the signature and the whole body, so there is nothing to replay a secret against. The next refused post will be testable here.`
        : `No refused ${laneName(provider)} post has been recorded, so there is nothing to test a secret against yet.`,
    };
  }
  const body = usable.row.payload;
  const presented = usable.d.sig.replace(/^sha256=/, "");
  const hex = crypto.createHmac("sha256", candidate).update(body, "utf8").digest("hex");
  const b64 = crypto.createHmac("sha256", candidate).update(body, "utf8").digest("base64");
  const when = usable.row.createdAt.toISOString();
  const header = usable.d.header ?? null;
  if (equalStrings(presented, hex)) return { ok: true, matched: "hex", when, header };
  if (equalStrings(presented, b64)) return { ok: true, matched: "base64", when, header };
  return { ok: false, kind: "no-match", when, header };
}

function equalStrings(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// RETRY — unresolved until resolved or dismissed
//
// Before RTP-28 this swept only ERROR rows from the last 24 hours, retried each
// ONE time, marked it FAILED and moved on — and webhookErrorCount's 7-day floor
// then aged the survivors out of the headline entirely, so a real dropped event
// became invisible twice over. Now: no recency floor, a backoff schedule, an
// idempotency check before every replay, and a row stays countable until it is
// processed or an owner explicitly dismisses it.
//
// The bookkeeping rides in WebhookEvent.error (no schema change) as a readable
// tail: "…message… [[retry n=2 next=2026-09-16T20:00:00.000Z]]".
// ---------------------------------------------------------------------------

const RETRY_RE = /\[\[retry n=(\d+)(?: next=([^\]\s]+))?(?: (gaveup))?\]\]/;
const DISMISS_MARK = "[[dismissed";
/** The tail of a terminal retry marker. Spelled as a bare substring because it
 *  is matched in SQL (`contains`) as well as by RETRY_RE — see the candidate
 *  query below. */
const GAVEUP_MARK = "gaveup]]";
/** Prefix on the message of a row we deliberately did NOT replay because a newer
 *  event for the same record already landed. Kept as a prefix rather than a new
 *  marker so the SQL exclusion stays one substring. */
const SUPERSEDED_PREFIX = "Superseded:";
const MAX_ATTEMPTS = 6;
/** Minutes to wait before attempt n+1. The cron is hourly, so the first entry
 *  means "next hourly run". */
const BACKOFF_MINUTES = [0, 60, 240, 720, 1440, 2880];

type RetryState = { attempts: number; nextAt: Date | null; gaveUp: boolean; dismissed: boolean; message: string };

export function readRetryState(error: string | null | undefined): RetryState {
  const raw = error ?? "";
  const dismissed = raw.includes(DISMISS_MARK);
  const m = raw.match(RETRY_RE);
  const message = raw.replace(RETRY_RE, "").replace(/\[\[dismissed[^\]]*\]\]/, "").trim();
  return {
    attempts: m ? Number(m[1]) : 0,
    nextAt: m?.[2] ? new Date(m[2]) : null,
    gaveUp: Boolean(m?.[3]),
    dismissed,
    message,
  };
}

/** The receivers stamp "UNSIGNED: …" on the row of every post they accepted
 *  without verifying, and /connections counts rows on that PREFIX. A replay
 *  rewrites `error`, so carry the marker across or an unsigned acceptance
 *  quietly stops being self-describing the first time it is retried. */
const UNSIGNED_PREFIX = "UNSIGNED";
function carryUnsigned(previous: string, next: string): string {
  if (!previous.startsWith(UNSIGNED_PREFIX)) return next;
  const marker = previous.split(" · ")[0];
  return next ? `${marker} · ${next}` : marker;
}

function writeRetryState(message: string, attempts: number, nextAt: Date | null): string {
  const tail = nextAt ? `[[retry n=${attempts} next=${nextAt.toISOString()}]]` : `[[retry n=${attempts} gaveup]]`;
  // Same rule as dismissal: the tail is load-bearing, so the message gives way.
  return `${message.slice(0, Math.max(0, 499 - tail.length))} ${tail}`.trim();
}

export async function retryFailedWebhooks(
  limit = 25,
): Promise<{ retried: number; recovered: number; failed: number; deduped: number; superseded: number; waiting: number }> {
  const candidates = await prisma.webhookEvent.findMany({
    // Gmail rows are excluded: they can't be re-dispatched from the stored
    // payload (it's just a snippet) — the gmail cron re-scans the inbox and
    // retries any non-PROCESSED row itself, so marking them FAILED here would
    // only fight that loop.
    where: {
      status: { in: ["ERROR", "FAILED"] },
      provider: { not: "gmail" },
      // Prisma's NOT-contains is NULL-hostile (a NULL error would be filtered
      // out entirely), so spell the null case explicitly.
      AND: [
        { OR: [{ error: null }, { NOT: { error: { contains: DISMISS_MARK } } }] },
        // Terminal rows are excluded HERE, not skipped in the loop: this query
        // takes the oldest N unresolved rows, so rows we have given up on would
        // otherwise fill the window forever and block every newer failure behind
        // them — head-of-line blocking on the very mechanism that exists to stop
        // events being lost. They stay visible (and dismissable) on /connections
        // through unresolvedWebhookFailures, which has no such exclusion.
        { OR: [{ error: null }, { NOT: { error: { contains: GAVEUP_MARK } } }] },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: Math.max(limit * 4, 50),
    select: { id: true, provider: true, eventType: true, externalId: true, payload: true, error: true, createdAt: true },
  });

  const now = Date.now();
  let recovered = 0;
  let failed = 0;
  let deduped = 0;
  let superseded = 0;
  let waiting = 0;
  let retried = 0;

  for (const row of candidates) {
    if (retried >= limit) break;
    const state = readRetryState(row.error);
    if (state.gaveUp) { waiting++; continue; }
    if (state.nextAt && state.nextAt.getTime() > now) { waiting++; continue; }

    // Idempotent replay: if the provider already re-delivered this SAME event
    // and that copy processed cleanly, re-running the processor would only
    // repeat work. Close this row against its twin instead.
    //
    // eventType is part of the key, and must stay part of it. externalId is not
    // an event id for every provider: aryeo uses the activity id and openphone
    // and slack use the message/event id (one event each), but SCRIPTING uses
    // the Studio PROJECT id, which every event about that project reuses — 12 of
    // its 55 ids already carry 2-4 different event types. Keyed on the id alone,
    // the first real Studio failure would be marked "already processed" against
    // an unrelated sibling event and closed WITHOUT EVER RUNNING — a hook or
    // script mirror that never happened, recorded as resolved and removed from
    // the list this ticket built to keep it actionable (RTP-28 review, Sep 16).
    if (row.externalId) {
      const twin = await prisma.webhookEvent.findFirst({
        where: {
          provider: row.provider,
          externalId: row.externalId,
          eventType: row.eventType,
          status: "PROCESSED",
          id: { not: row.id },
        },
        select: { id: true },
      });
      if (twin) {
        await prisma.webhookEvent.update({
          where: { id: row.id },
          data: {
            status: "PROCESSED",
            processedAt: new Date(),
            error: carryUnsigned(state.message, "Resolved: the same event was delivered again and processed."),
          },
        });
        deduped++;
        continue;
      }

      // Ordering guard. Dropping the old 24h floor means a row can now be
      // replayed up to 30 days late, and one replayable event type is
      // DESTRUCTIVE: scripting's `project.deleted` wipes scriptingId /
      // scriptingStatus / scriptingUrl. A delete that failed three weeks ago
      // because the job wasn't linked yet would, once the link finally lands,
      // unlink it again — the retry's own rationale turned inside out. So a row
      // never lands on top of a NEWER processed event for the same record: it
      // stops here, stays on the list, and waits for a human to dismiss it.
      const newer = await prisma.webhookEvent.findFirst({
        where: {
          provider: row.provider,
          externalId: row.externalId,
          status: "PROCESSED",
          createdAt: { gt: row.createdAt },
          id: { not: row.id },
        },
        orderBy: { createdAt: "desc" },
        select: { eventType: true, createdAt: true },
      });
      if (newer) {
        const note = `${SUPERSEDED_PREFIX} a newer event (${newer.eventType ?? "unknown"}) for the same record processed on ${newer.createdAt.toISOString()}, so replaying this one could undo it. Not retried — dismiss it, or replay it by hand if you know it is still wanted.`;
        await prisma.webhookEvent.update({
          where: { id: row.id },
          data: { status: "FAILED", error: writeRetryState(carryUnsigned(state.message, note), state.attempts, null) },
        });
        superseded++;
        continue;
      }
    }

    retried++;
    let payload: Record<string, unknown> = {};
    try {
      payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
    } catch {
      /* truncated / non-JSON payload — dispatch with what we have */
    }
    try {
      await dispatch(row.provider, row.eventType, payload);
      await prisma.webhookEvent.update({
        where: { id: row.id },
        data: { status: "PROCESSED", processedAt: new Date(), error: carryUnsigned(state.message, "") || null },
      });
      recovered++;
    } catch (e) {
      const attempts = state.attempts + 1;
      const message = carryUnsigned(state.message, (e instanceof Error ? e.message : String(e)).slice(0, 380));
      const nextAt =
        attempts >= MAX_ATTEMPTS ? null : new Date(now + BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)] * 60_000);
      await prisma.webhookEvent.update({
        where: { id: row.id },
        // ERROR while we're still trying; FAILED once we've given up. Either way
        // the row keeps counting on /connections until someone acts on it.
        data: { status: nextAt ? "ERROR" : "FAILED", error: writeRetryState(message, attempts, nextAt) },
      });
      failed++;
    }
  }

  // Piggy-backs on the hourly sync that already calls this sweep, so a lane
  // going quiet raises an alarm without another cron entry.
  await alertQuietWebhookLanes().catch(() => {});

  return { retried, recovered, failed, deduped, superseded, waiting };
}

/** One manual attempt from /connections, ignoring the backoff clock. */
export async function retryWebhookEventNow(id: string): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.webhookEvent.findUnique({
    where: { id },
    select: { id: true, provider: true, eventType: true, payload: true, status: true, error: true },
  });
  if (!row) return { ok: false, message: "That event is no longer stored." };
  if (row.provider === "gmail") return { ok: false, message: "Gmail events are re-read from the mailbox by the mail sync, not replayed from here." };
  let payload: Record<string, unknown> = {};
  try {
    payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
  } catch { /* dispatch with what we have */ }
  try {
    await dispatch(row.provider, row.eventType, payload);
    const prior = readRetryState(row.error);
    await prisma.webhookEvent.update({
      where: { id },
      data: { status: "PROCESSED", processedAt: new Date(), error: carryUnsigned(prior.message, "") || null },
    });
    return { ok: true, message: "Replayed — that event processed cleanly and is off the list." };
  } catch (e) {
    const state = readRetryState(row.error);
    const attempts = state.attempts + 1;
    const message = carryUnsigned(state.message, (e instanceof Error ? e.message : String(e)).slice(0, 380));
    const nextAt = attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)] * 60_000);
    await prisma.webhookEvent.update({ where: { id }, data: { status: nextAt ? "ERROR" : "FAILED", error: writeRetryState(message, attempts, nextAt) } });
    return { ok: false, message: `Still failing: ${message}` };
  }
}

/** Explicit dismissal — the only other way off the list. Keeps the row and its
 *  payload; just stops it counting, with who and when written into the row. */
export async function dismissWebhookEvent(id: string, by?: string | null): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.webhookEvent.findUnique({ where: { id }, select: { error: true } });
  if (!row) return { ok: false, message: "That event is no longer stored." };
  const state = readRetryState(row.error);
  if (state.dismissed) return { ok: true, message: "Already dismissed." };
  const tail = `[[dismissed at=${new Date().toISOString()}${by ? ` by=${by}` : ""}]]`;
  // Trim the MESSAGE to fit, never the tail: slicing the whole string at 500
  // would cut the marker off the end and the row would keep counting.
  const base = (row.error ?? state.message ?? "").slice(0, Math.max(0, 499 - tail.length));
  await prisma.webhookEvent.update({ where: { id }, data: { error: `${base} ${tail}`.trim() } });
  return { ok: true, message: "Dismissed — it stays in the log, it just stops counting." };
}

// Re-run the same processor the receiver used, reconstructing its args from the
// stored raw payload (mirrors each route's POST handler exactly).
async function dispatch(provider: string, eventType: string | null, payload: Record<string, unknown>) {
  if (provider === "openphone") {
    const { processOpenPhoneEvent } = await import("@/app/api/webhooks/openphone/route");
    await processOpenPhoneEvent((payload.type as string) || eventType || "unknown", payload);
  } else if (provider === "aryeo") {
    const { processAryeoEvent } = await import("@/app/api/webhooks/aryeo/route");
    await processAryeoEvent(eventType || "unknown", payload);
  } else if (provider === "slack") {
    const { processSlackEvent } = await import("@/app/api/webhooks/slack/route");
    await processSlackEvent((payload.event as Record<string, unknown>) || {});
  } else if (provider === "scripting") {
    // Scripting rows store the raw {event, data} body.
    const { processScriptingEvent } = await import("@/app/api/webhooks/scripting/route");
    type StudioData = Parameters<typeof processScriptingEvent>[1];
    await processScriptingEvent((payload.event as string) || eventType || "unknown", ((payload.data as StudioData) || {}) as StudioData);
  } else {
    throw new Error(`no retry handler for provider "${provider}"`);
  }
}

/** Count of incoming events still needing attention — the number in the health
 *  strip's header. NO time floor any more: a dropped event does not stop
 *  mattering because it is eight days old, and the 7-day cutoff was quietly
 *  hiding the oldest (and worst) ones. */
export async function webhookErrorCount(): Promise<number> {
  return prisma.webhookEvent.count({
    where: {
      status: { in: ["ERROR", "FAILED"] },
      OR: [{ error: null }, { NOT: { error: { contains: DISMISS_MARK } } }],
    },
  });
}

export type UnresolvedWebhookFailure = {
  id: string;
  provider: string;
  eventType: string | null;
  at: string;
  status: string;
  message: string;
  attempts: number;
  nextAt: string | null;
  gaveUp: boolean;
  /** Stopped because a NEWER event for the same record already processed — not
   *  because it ran out of tries. "Gave up after 0 tries" would be nonsense. */
  superseded: boolean;
};

/** The actual list behind that count, for the health strip. The count is
 *  webhookErrorCount() and the two share a where-clause on purpose: one
 *  definition of "unresolved", so the header number and the rows agree. */
export async function unresolvedWebhookFailures(limit = 20): Promise<UnresolvedWebhookFailure[]> {
  const rows = await prisma.webhookEvent.findMany({
    where: {
      status: { in: ["ERROR", "FAILED"] },
      OR: [{ error: null }, { NOT: { error: { contains: DISMISS_MARK } } }],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, provider: true, eventType: true, createdAt: true, status: true, error: true },
  });
  return rows.map((r) => {
    const s = readRetryState(r.error);
    return {
      id: r.id,
      provider: r.provider,
      eventType: r.eventType,
      at: r.createdAt.toISOString(),
      status: r.status,
      message: s.message || "No reason recorded.",
      attempts: s.attempts,
      nextAt: s.nextAt ? s.nextAt.toISOString() : null,
      gaveUp: s.gaveUp,
      // `includes`, not `startsWith`: an unsigned row keeps its UNSIGNED prefix
      // (see carryUnsigned) and only one of the two can come first.
      superseded: s.gaveUp && s.message.includes(SUPERSEDED_PREFIX),
    };
  });
}

// Per-provider webhook health for the Connections "Sync health" panel: how many
// events were REJECTED at the door (signature failures) vs ERROR/FAILED in
// processing over the last 7 days. Rejected events were previously counted
// nowhere — 765 bounced Aryeo events ran silent for 13 days while the page
// stayed green (audit crack #7).
export type WebhookProviderHealth = { provider: string; rejected: number; errored: number };
export async function webhookHealthByProvider(days = 7): Promise<WebhookProviderHealth[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.webhookEvent.groupBy({
    by: ["provider", "status"],
    where: { status: { in: ["REJECTED", "ERROR", "FAILED"] }, createdAt: { gt: cutoff } },
    _count: { _all: true },
  });
  const byProvider = new Map<string, WebhookProviderHealth>();
  for (const r of rows) {
    const cur = byProvider.get(r.provider) ?? { provider: r.provider, rejected: 0, errored: 0 };
    if (r.status === "REJECTED") cur.rejected += r._count._all;
    else cur.errored += r._count._all;
    byProvider.set(r.provider, cur);
  }
  return [...byProvider.values()].sort((a, b) => b.rejected + b.errored - (a.rejected + a.errored));
}

// ---------------------------------------------------------------------------
// LANE HEALTH — "is this thing still delivering?"
// ---------------------------------------------------------------------------

/** Anything that is not a refusal counts as ARRIVED: a row that errored in
 *  processing still proves the provider reached us. */
const ACCEPTED_STATUSES = ["RECEIVED", "PROCESSED", "ERROR", "FAILED"];

/** When is quiet WRONG? Tuned against the real traffic (Sep 16): Aryeo ~28
 *  events/day before it died, OpenPhone ~50, Slack ~10, Gmail ~20 — one silent
 *  day for any of those is an outage. Script Studio runs ~1/day and is silent
 *  on ordinary days, so it gets three. */
const QUIET_BUSY_PER_DAY = 3;
const QUIET_BUSY_HOURS = 24;
const QUIET_BURSTY_HOURS = 72;
/** How much history a lane needs before its silence is worth shouting about. */
const QUIET_MIN_BASELINE = 10;
/** …and the length of silence after which we shout anyway. This rail exists for
 *  the end of a long outage: the 30-day purge eats a dead lane's history, so its
 *  baseline eventually thins out even though it is anchored. A week of nothing
 *  is wrong whatever the history says. */
const QUIET_HARD_HOURS = 168;

export type WebhookLaneHealth = {
  provider: string;
  name: string;
  lastAcceptedAt: string | null;
  lastAcceptedType: string | null;
  /** Last time ANYTHING arrived, accepted or refused — the honest "since". */
  lastSeenAt: string | null;
  lastRejectedAt: string | null;
  lastRejectedReason: string | null;
  accepted24h: number;
  accepted7d: number;
  /** Accepted events in the 28 days ENDING AT the last delivery: does this lane
   *  normally deliver? Anchored there, not to now, so it cannot decay to zero
   *  while the lane is dead — see webhookLaneHealth. */
  baseline: number;
  rejected7d: number;
  unresolved: number;
  /** Whole hours since this lane last DELIVERED something (refusals don't
   *  count — a lane bouncing every post is failing, not delivering). Null when
   *  it has never delivered. */
  quietHours: number | null;
  /** Normally delivers, and has now delivered nothing for longer than its own
   *  normal gap. See QUIET_* below — a busy lane is late after a day, a bursty
   *  one isn't late until three. */
  silent: boolean;
  /** Nothing this lane ever delivered is still on record. Either it has never
   *  reached us, or the outage has outlived the 30-day event log — which is a
   *  worse state than `silent`, not a better one, so it gets its own flag and
   *  never falls through to the benign "quiet by nature" chip. */
  neverDelivered: boolean;
  /** The silence started with bounced signatures — a configuration fault, not an outage. */
  startedWithRejections: boolean;
  enforced: boolean;
  enforceable: boolean;
  isReceiver: boolean;
  secretStored: boolean;
  secretReadable: boolean;
  /** Refused posts we could replay a candidate secret against. */
  replayable: number;
  /** The plain sentence for the office. Null when the lane is healthy. */
  sentence: string | null;
};

/** Which Connection row carries each receiver's signing secret. Scripting's is
 *  an env var (SCRIPTING_WEBHOOK_SECRET), so it has no row to read. */
const SECRET_ROW: Record<string, string | null> = {
  aryeo: "aryeo_webhook",
  openphone: "openphone_webhook",
  scripting: null,
  slack: null,
  gmail: null,
};

export async function webhookLaneHealth(): Promise<WebhookLaneHealth[]> {
  const now = Date.now();
  const enforced = await enforcedAll();
  const out: WebhookLaneHealth[] = [];

  for (const provider of WEBHOOK_LANES) {
    // Fetched FIRST because the rhythm baseline below is anchored to it.
    const lastAccepted = await prisma.webhookEvent.findFirst({
      where: { provider, status: { in: ACCEPTED_STATUSES } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, eventType: true },
    });
    const anchor = lastAccepted?.createdAt ?? null;

    const [lastRejected, lastSeen, accepted24h, accepted7d, baseline, rejected7d, unresolved] = await Promise.all([
      prisma.webhookEvent.findFirst({
        where: { provider, status: "REJECTED" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, error: true },
      }),
      prisma.webhookEvent.findFirst({ where: { provider }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      prisma.webhookEvent.count({ where: { provider, status: { in: ACCEPTED_STATUSES }, createdAt: { gt: new Date(now - 86400_000) } } }),
      prisma.webhookEvent.count({ where: { provider, status: { in: ACCEPTED_STATUSES }, createdAt: { gt: new Date(now - 7 * 86400_000) } } }),
      // THE RHYTHM BASELINE — the 28 days ending at this lane's LAST DELIVERY,
      // not the 28 days ending now (RTP-28 review, Sep 16). Anchored to now, a
      // lane that stays dead slowly empties its own baseline and stops being
      // loud: Aryeo's was 795 on Sep 16, 490 a week later, 239 the week after
      // and 0 by Oct 7 — at which point the red banner would have vanished and
      // the strip would have gone quietly grey precisely when the outage had
      // been ignored longest. That is the failure this panel exists to remove.
      anchor
        ? prisma.webhookEvent.count({
            where: {
              provider,
              status: { in: ACCEPTED_STATUSES },
              createdAt: { gt: new Date(anchor.getTime() - 28 * 86400_000), lte: anchor },
            },
          })
        : Promise.resolve(0),
      prisma.webhookEvent.count({ where: { provider, status: "REJECTED", createdAt: { gt: new Date(now - 7 * 86400_000) } } }),
      prisma.webhookEvent.count({
        where: {
          provider,
          status: { in: ["ERROR", "FAILED"] },
          OR: [{ error: null }, { NOT: { error: { contains: DISMISS_MARK } } }],
        },
      }),
    ]);

    const secretRow = SECRET_ROW[provider];
    let secretStored = false;
    let secretReadable = false;
    if (secretRow) {
      const row = await prisma.connection.findUnique({ where: { provider: secretRow }, select: { secretEncrypted: true } }).catch(() => null);
      secretStored = Boolean(row?.secretEncrypted);
      secretReadable = secretStored ? Boolean(await getSecret(secretRow).catch(() => null)) : false;
    } else if (provider === "scripting") {
      secretStored = Boolean(process.env.SCRIPTING_WEBHOOK_SECRET);
      secretReadable = secretStored;
    } else if (provider === "slack") {
      secretStored = Boolean(process.env.SLACK_SIGNING_SECRET);
      secretReadable = secretStored;
    }

    const lastSeenAt = lastSeen?.createdAt ?? null;
    // Silence is measured from the last DELIVERY, not the last contact: a lane
    // bouncing a post an hour is failing loudly, and that gets its own sentence.
    const quietHours = lastAccepted ? Math.floor((now - lastAccepted.createdAt.getTime()) / 3600_000) : null;
    const perDay = baseline / 28; // the anchored baseline window is exactly 28 days
    // A lane's own rhythm decides when quiet is wrong. Aryeo ran ~28 events a
    // day, so one silent day is an outage; Script Studio runs ~1 and is silent
    // on plenty of ordinary days, so crying wolf at 24h would train the office
    // to ignore this strip — which is how eight days of dead Aryeo went unread.
    const threshold = perDay >= QUIET_BUSY_PER_DAY ? QUIET_BUSY_HOURS : QUIET_BURSTY_HOURS;
    // Nothing it ever delivered is still on record — the state AFTER a long
    // outage, once the purge has eaten the history. Kept separate from `silent`
    // so it can never read as healthy.
    const neverDelivered = !lastAccepted;
    const silent =
      !neverDelivered &&
      quietHours !== null &&
      quietHours >= threshold &&
      (baseline >= QUIET_MIN_BASELINE || quietHours >= QUIET_HARD_HOURS);
    // Did the quiet start at the door? True when the last thing we ever saw was
    // a refusal — the Sep 8 Aryeo shape exactly.
    const startedWithRejections =
      Boolean(lastRejected) &&
      (!lastAccepted || lastRejected!.createdAt.getTime() >= lastAccepted.createdAt.getTime());

    const replayable = await countReplayable(provider);

    out.push({
      provider,
      name: laneName(provider),
      lastAcceptedAt: lastAccepted?.createdAt.toISOString() ?? null,
      lastAcceptedType: lastAccepted?.eventType ?? null,
      lastSeenAt: lastSeenAt?.toISOString() ?? null,
      lastRejectedAt: lastRejected?.createdAt.toISOString() ?? null,
      lastRejectedReason: lastRejected ? rejectionSentence(lastRejected.error) : null,
      accepted24h,
      accepted7d,
      baseline,
      rejected7d,
      unresolved,
      quietHours,
      silent,
      neverDelivered,
      startedWithRejections,
      enforced: enforced[provider] ?? false,
      enforceable: ENFORCE_TOGGLEABLE.includes(provider),
      isReceiver: (WEBHOOK_RECEIVERS as readonly string[]).includes(provider),
      secretStored,
      secretReadable,
      replayable,
      sentence: officeSentence(provider, {
        silent,
        neverDelivered,
        startedWithRejections,
        lastSeenAt,
        secretStored,
        secretReadable,
        rejected7d,
      }),
    });
  }
  return out;
}

async function countReplayable(provider: string): Promise<number> {
  const rows = await prisma.webhookEvent.findMany({
    where: { provider, status: "REJECTED" },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { error: true },
  });
  return rows.filter((r) => isReplayable(decodeRejection(r.error))).length;
}

/** The sentence the office reads. Plain English, says what is lost and what to
 *  do, and never says "healthy" about a lane it cannot see. */
function officeSentence(
  provider: string,
  s: {
    silent: boolean;
    neverDelivered: boolean;
    startedWithRejections: boolean;
    lastSeenAt: Date | null;
    secretStored: boolean;
    secretReadable: boolean;
    rejected7d: number;
  },
): string | null {
  const copy = LANE[provider] ?? { name: provider, cover: "events are not arriving", fix: "Check the connection.", fixAfterRejections: "Check the signing secret." };
  // The live fail-open the audit flagged: a secret is stored but the hub cannot
  // decrypt it, so the receiver silently reverted to accepting anything.
  if (s.secretStored && !s.secretReadable) {
    return `${copy.name} has a signing secret stored that the hub can no longer read — it is accepting unsigned posts. Re-save the signing secret on this page.`;
  }
  // Nothing on record at all. The event log only goes back 30 days, so this is
  // either a lane that has never reached us or one whose outage has now outlived
  // the log — and the second is the one that matters, so say both and assume the
  // worse. Silence here used to print nothing whatsoever.
  if (s.neverDelivered) {
    const fix = s.rejected7d > 0 ? copy.fixAfterRejections : copy.fix;
    return `Nothing has ever arrived from ${copy.name} — or its last delivery is now older than the 30-day event log. Assume it is not delivering: ${copy.cover}. ${fix}`;
  }
  if (s.silent && s.lastSeenAt) {
    const fix = s.startedWithRejections ? copy.fixAfterRejections : copy.fix;
    return `${copy.name} has not delivered a live event since ${etMonthDay(s.lastSeenAt)} — ${copy.cover}. ${fix}`;
  }
  if (s.rejected7d > 0 && s.startedWithRejections) {
    return `${copy.name} posts are bouncing at the door — ${s.rejected7d} refused in the last 7 days. ${copy.fixAfterRejections}`;
  }
  return null;
}

/** The bell version of the same news. notifyInApp clips a body at 140
 *  characters, so the long office sentence would lose its "what to do" half —
 *  this one is written to fit whole. The page carries the full sentence. */
export function quietAlertBody(lane: WebhookLaneHealth): string {
  const copy = LANE[lane.provider];
  const fix = lane.startedWithRejections ? copy?.fixAfterRejections : copy?.fix;
  const fallback = fix ?? "Check the connection on Connections.";
  if (lane.neverDelivered) return `Nothing on record in the last 30 days. ${fallback}`.slice(0, 140);
  const since = lane.lastSeenAt ? etMonthDay(new Date(lane.lastSeenAt)) : "we last looked";
  return `Nothing since ${since}. ${fallback}`.slice(0, 140);
}

// ---------------------------------------------------------------------------
// THE QUIET ALARM
//
// The failure this whole batch exists for produced no alert at all after its
// first hour: two "aryeo webhooks bouncing" pings on Sep 8, then eight days of
// silence that nothing was watching for. A lane that normally delivers and then
// delivers nothing for 24h now says so — once per provider per day, OWNER and
// ADMIN, on the bell.
// ---------------------------------------------------------------------------

export async function alertQuietWebhookLanes(): Promise<{ alerted: string[] }> {
  const alerted: string[] = [];
  let lanes: WebhookLaneHealth[] = [];
  try {
    lanes = await webhookLaneHealth();
  } catch {
    return { alerted };
  }
  const { notifyInApp } = await import("@/lib/notify");
  const day = etDayKey(new Date());
  for (const lane of lanes) {
    // neverDelivered keeps alerting after the purge has eaten a dead lane's
    // history: an outage that has run a month is the last thing that should go
    // quiet on the bell (RTP-28 review, Sep 16).
    if (!(lane.silent || lane.neverDelivered) || !lane.sentence) continue;
    try {
      await notifyInApp({
        kind: "system",
        title: lane.neverDelivered
          ? `${lane.name} has delivered nothing on record`
          : `${lane.name} has gone quiet (${lane.quietHours ?? 24}h)`,
        body: quietAlertBody(lane),
        href: "/connections",
        targets: [{ roles: ["OWNER", "ADMIN"] }],
        // One per provider per ET day — the dedupeKey is unique in the DB, so a
        // second call the same day inserts nothing.
        dedupeKey: `whquiet-${lane.provider}-${day}`,
      });
      alerted.push(lane.provider);
    } catch {
      /* alerting must never break the sweep that calls this */
    }
  }
  return { alerted };
}
