import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { etMonthDay } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// THE CUTOVER, AND WHY IT IS A STATE MACHINE INSTEAD OF A SAVE BUTTON
//
// On 8 Sep 2026 someone saved an Aryeo signing secret on /connections. The
// receiver's rule at the time was "a secret exists, therefore verify" — so from
// that moment every post that did not carry a matching signature was refused.
// Aryeo had never been given that secret. 36 real events bounced between
// 12:14 and 14:20 UTC that morning, Aryeo exhausted its two retries, and then
// it stopped delivering altogether. Nothing arrived for the next EIGHT DAYS and
// no screen went red, because the hourly reconcile kept importing orders and
// every alert in the hub keys off errors — and there were no errors, because
// there were no requests.
//
// The defect is not the crypto. The HMAC check is correct and matches Aryeo
// byte for byte. The defect is that SAVING A SECRET AND REQUIRING IT WERE THE
// SAME ACT, at an instant when the other side could not possibly have it yet.
//
// So they are separated here. Saving a secret puts the lane in WATCHING: every
// post is still accepted, every post's credential is still evaluated, and the
// first post that actually VERIFIES is treated as proof that Aryeo now holds
// the secret. Only then does the hub start refusing. The proof is written to
// the database, so every serverless instance reads the same decision.
//
//   watching  → accept everything, evaluate everything, arm on proof
//   armed     → refuse anything that does not verify   (the goal state)
//   holding   → accept everything, evaluate everything, DO NOT auto-arm
//
// HOLDING is the escape hatch, and it is deliberately not the same as WATCHING.
// If enforcement has just been turned off — by a person, or by the probation
// guard below — the reason is almost always "something else is posting here
// unsigned". Dropping back into WATCHING would let the next good post re-arm
// immediately and start the bouncing over again, on a loop nobody is watching.
// Holding waits for a human to look first.
//
// The other switch, webhookEnforced() in lib/webhookRetry, answers a different
// question: what to do when there is NO secret at all. The two never overlap —
// no secret is its domain, a stored secret is this module's — and between them
// every inbound post has exactly one rule deciding its fate.
//
// ONE MORE THING, ADDED AFTER REVIEW (Sep 16, same day). The automatic
// climb-down below is a DISARM, and the endpoint it protects is reachable by
// anyone who knows the URL. The first cut counted any refused body that merely
// "looked like" an Aryeo event — and a 19-byte `{"object":"ORDER"}` looked like
// one. Three of those inside the probation window and the hub disarmed itself,
// permanently, for a caller who had no secret, no timing and no knowledge of
// the cutover: enforcement could never have stuck through a single probation
// window. See noteRefusalWhileArmed for the four gates that now stand in front
// of that switch, and why the evidence they demand cannot be manufactured from
// outside.
// ---------------------------------------------------------------------------

export type ArmMode = "watching" | "armed" | "holding";

/** How the caller proved it holds the secret. A signature is a MAC over THIS
 *  body; a header token only proves the sender knows the string. Both count as
 *  proof for arming — if Aryeo support enabled custom headers instead of
 *  signing, the header is the mechanism we were given — but which one it was is
 *  recorded, because it changes what the guarantee is worth. */
export type Credential = "signature" | "header";

type Proof = {
  at: string;
  credential: Credential;
  /** Which header carried it, so a header-NAME mismatch stays diagnosable. */
  header: string | null;
  eventType: string | null;
};

type StoredArm = {
  v: 1;
  mode: ArmMode;
  /** WHICH secret this decision is about — see armFingerprint. */
  fingerprint: string;
  /** When this secret started being watched (i.e. when it was generated/saved). */
  watchingSince: string;
  armedAt?: string | null;
  /** "Aryeo" when a verified post armed it; an email when a person did. */
  armedBy?: string | null;
  proof?: Proof | null;
  /** Set when the probation guard or a person turned enforcement back off. */
  heldAt?: string | null;
  heldBy?: string | null;
  heldReason?: string | null;
  /** When the hub last climbed down BY ITSELF for this secret. Survives a
   *  re-arm on purpose: the automatic disarm is allowed exactly once per
   *  cutover, so nobody can sit on the endpoint knocking enforcement off every
   *  time a person turns it back on. A new secret starts a new cutover and
   *  clears it, because the whole record is fingerprinted to the secret. */
  autoHeldAt?: string | null;
};

export type ArmState = StoredArm & {
  /** True when the stored record was about a DIFFERENT secret and has been
   *  disregarded — the current secret has never been proved. */
  staleForThisSecret: boolean;
};

const armKey = (provider: string) => `webhook-arm:${provider}`;

// ---------------------------------------------------------------------------
// SECRETS
// ---------------------------------------------------------------------------

/** Aryeo's docs: "Any arbitrary string can be used as a secret to complete the
 *  signing." So the hub makes one, and it is the whole of the authentication —
 *  32 bytes from the OS CSPRNG, never Math.random. base64url rather than plain
 *  base64 so it survives being pasted into a dashboard field, an HTTP header or
 *  a URL without "+", "/" or "=" being mangled or trimmed. */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("base64url"); // 43 characters
}

/** A short, non-reversible name for a secret, so a stored decision can say
 *  WHICH secret it was about without keeping the secret anywhere but the
 *  encrypted credential store. Never rendered to a browser. */
export function armFingerprint(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16);
}

/** Constant-time string compare, gated on BYTE length.
 *
 *  timingSafeEqual THROWS when the two buffers differ in length, and a JS
 *  string's .length counts CHARACTERS, not bytes — so a 64-character token made
 *  of multibyte characters clears a naive character gate and then blows up
 *  inside the compare, turning what should be a clean 401 into a 500 (with a
 *  stack trace, for an unauthenticated caller). Both live receivers were bitten
 *  by exactly this; do not "simplify" it back. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * THE ALTERNATIVE CREDENTIAL — header names, kept here rather than in the
 * receiver so the screen that tells Aryeo which header to use and the code that
 * reads it cannot drift apart.
 *
 * Aryeo's webhook docs offer custom headers for "additional validation", and
 * their support may enable that instead of body signing. The first name is the
 * one the Connections card tells Jordan to give them; the second is accepted
 * because it is the obvious thing someone types instead.
 *
 * Strictly disjoint from the receiver's signature headers: a single header name
 * must never be readable as both a MAC over the body and a bare password.
 */
export const TOKEN_HEADERS = ["x-realtour-token", "x-webhook-secret"] as const;
export const RECOMMENDED_TOKEN_HEADER = TOKEN_HEADERS[0];

// ---------------------------------------------------------------------------
// READING AND WRITING THE DECISION
//
// Straight to AppSetting, deliberately NOT through lib/settings getSetting():
// that helper caches for 60 seconds per lambda, and the two moments this state
// is read are the two moments a stale answer hurts most — the instant a post
// could arm the lane, and the instant an owner has pressed "stop enforcing"
// because live events are bouncing. An escape hatch that takes effect "within a
// minute" is not an escape hatch. Aryeo delivers ~41 events a day, so reading a
// single indexed row per post costs nothing worth having.
// ---------------------------------------------------------------------------

function freshRecord(fingerprint: string): StoredArm {
  return { v: 1, mode: "watching", fingerprint, watchingSince: new Date().toISOString() };
}

async function rawArm(provider: string): Promise<StoredArm | null> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: armKey(provider) }, select: { value: true } });
    if (!row) return null;
    const d = JSON.parse(row.value) as StoredArm;
    if (!d || d.v !== 1 || !d.fingerprint) return null;
    return d.mode === "armed" || d.mode === "holding" || d.mode === "watching" ? d : null;
  } catch {
    return null;
  }
}

/**
 * What should this receiver do with a post it cannot verify, given the secret
 * it currently holds?
 *
 * A record written about a DIFFERENT secret is disregarded and the lane starts
 * watching again. That single rule closes a family of holes at once: replacing
 * the secret cannot inherit the old one's proof, an APP_SECRET rotation that
 * changes what decrypts cannot leave a stale "armed" standing, and a secret
 * generated today cannot be treated as proved by a post signed last week.
 */
export async function readArmState(provider: string, secret: string): Promise<ArmState> {
  const fingerprint = armFingerprint(secret);
  const stored = await rawArm(provider);
  if (!stored) return { ...freshRecord(fingerprint), staleForThisSecret: false };
  if (stored.fingerprint !== fingerprint) {
    return { ...freshRecord(fingerprint), staleForThisSecret: true };
  }
  return { ...stored, staleForThisSecret: false };
}

async function writeArm(provider: string, record: StoredArm): Promise<void> {
  const value = JSON.stringify(record);
  await prisma.appSetting
    .upsert({ where: { key: armKey(provider) }, create: { key: armKey(provider), value }, update: { value } })
    .catch(() => {
      /* The receiver's answer to THIS post never depends on this write landing.
         A missed arm just means the next verified post arms instead. */
    });
}

/** Read the decision for the office WITHOUT needing the secret in hand — used
 *  by the Connections screen, which must be able to describe a lane whose
 *  secret it cannot decrypt. Returns null when nothing has ever been recorded. */
export async function peekArmState(provider: string): Promise<StoredArm | null> {
  return rawArm(provider);
}

// ---------------------------------------------------------------------------
// ARMING — the moment we learn the other side really has the secret
// ---------------------------------------------------------------------------

/** How long after the cutover an automatic climb-down is still possible, and how
 *  many genuine refusals inside that window trigger it.
 *
 *  THREE is not arbitrary: Aryeo retries a failed delivery after 10 seconds and
 *  once more after 100 seconds, then gives up. So exactly one real subscription
 *  posting without the secret produces three refusals in under two minutes.
 *  That is the signal this guard exists to catch — a second Aryeo subscription
 *  (an old *.vercel.app endpoint, say) that nobody updated — and it catches it
 *  inside two minutes rather than eight days.
 *
 *  The clock runs from the FIRST POST AFTER ARMING, not from armedAt. Aryeo has
 *  been silent since 7 Sep, and "Start checking now" can be pressed days before
 *  their support actually enables the endpoint; dating the window from the
 *  button press meant that in the one scenario we know we are in — a quiet lane
 *  that resumes later — the guard would already have expired before the first
 *  post ever landed, and the feed would have died until the next daily alarm. */
export const PROBATION_HOURS = 24;
const PROBATION_REFUSALS = 3;

/** Aryeo resource ids are UUIDs. Used two ways below — as a cheap shape check on
 *  the post that ARMS the lane, and as the first half of the much stricter test
 *  on a post that could DISARM it. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Called on every post that VERIFIED. Arms the lane if it was watching.
 *
 * The guards are all about one question: is this post real evidence that the
 * PROVIDER is now signing its live traffic?
 */
export async function noteVerifiedDelivery(
  provider: string,
  args: { secret: string; credential: Credential; header: string | null; eventType: string | null; payload: Record<string, unknown> },
): Promise<{ armed: boolean; why: string }> {
  // GUARD 1 — a preview deployment shares this database with production.
  // Vercel previews run the same code against the same DATABASE_URL, so a post
  // (or a developer's curl) landing on a preview host could otherwise write an
  // "armed" decision that production then enforces. Previews may evaluate and
  // accept; they may not change the decision. VERCEL_ENV is undefined outside
  // Vercel, so local work is unaffected.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    return { armed: false, why: "not arming from a preview deployment" };
  }

  const state = await readArmState(provider, args.secret);
  if (state.mode === "armed") return { armed: false, why: "already armed" };
  if (state.mode === "holding") {
    // Enforcement was turned off deliberately. A good post is not permission to
    // turn it back on — see the note at the top of this file.
    return { armed: false, why: "holding: waiting for a person to arm it" };
  }

  // GUARD 2 — the post has to be real traffic, not a probe.
  // A correctly-signed empty body, health check or hand-rolled test proves only
  // that someone had the secret at that moment; it does not prove the PROVIDER
  // is signing the orders and appointments we need. (The stored event log
  // already contains one row typed "probe", so this is not hypothetical.) Only
  // a payload that classifies as a genuine Aryeo resource AND names the
  // resource it is about counts as proof — checked against 400 stored live
  // payloads, every single one carries a UUID id, and a body thin enough to be
  // a health check carries none.
  if (!(await armWorthyPayload(args.payload))) {
    return { armed: false, why: "verified, but the body is not a recognisable Aryeo event" };
  }

  const now = new Date().toISOString();
  await writeArm(provider, {
    v: 1,
    mode: "armed",
    fingerprint: armFingerprint(args.secret),
    watchingSince: state.watchingSince,
    armedAt: now,
    armedBy: "Aryeo",
    proof: { at: now, credential: args.credential, header: args.header, eventType: args.eventType },
    // Carried forward, never reset by arming: see StoredArm.autoHeldAt.
    autoHeldAt: state.autoHeldAt ?? null,
  });

  // Two lambdas can race here and both write "armed" a moment apart. They write
  // the same decision and the later armedAt is off by milliseconds; a
  // transaction to make the timestamp exact would buy nothing.
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "system",
      title: `${provider === "aryeo" ? "Aryeo" : provider} is signing its posts`,
      body: "Verified post received, so the hub now checks every one and refuses anything that doesn't match.",
      href: "/connections",
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `wharm-${provider}-${now.slice(0, 10)}`,
    });
  } catch {
    /* the decision stands whether or not the bell rings */
  }
  return { armed: true, why: "verified live event — enforcement is on" };
}

/**
 * Called on every post REFUSED while armed. Two jobs, in this order: say so out
 * loud, and — only on evidence that cannot be manufactured from outside — climb
 * back down because the cutover has visibly gone wrong.
 *
 * Returns true when it reverted, so the receiver can say so in the log.
 *
 * FOUR GATES STAND IN FRONT OF THE DISARM, because this endpoint is reachable
 * by anyone who knows its URL and a refusal is a 401 where an acceptance is a
 * 200 — which makes the armed state directly observable from outside. Each gate
 * answers a different way the first cut could be walked through:
 *
 *   1. NOTHING HAS VERIFIED SINCE WE ARMED. If even one post has verified since
 *      the cutover, Aryeo demonstrably holds the secret and the feed works;
 *      whatever is bouncing is someone else's traffic, not evidence the cutover
 *      broke, and disarming would be exactly the wrong response. This also
 *      covers the "two subscriptions, both live, one signed" case: the signed
 *      one is delivering the same events, so nothing is actually lost — that
 *      wants a person and a tidy-up in Aryeo, and gets the alarm below.
 *   2. THE BODY NAMES A RESOURCE WE ALREADY HOLD. Not "looks like an Aryeo
 *      event" — `{"object":"ORDER"}` looks like one, and three of those used to
 *      be enough. It must carry the UUID of an order, listing, appointment or
 *      customer that is already in our database. Those ids are unguessable and
 *      are not ours to leak, so only Aryeo — or something already receiving
 *      Aryeo's deliveries — can produce one. Measured against the 400 most
 *      recent stored Aryeo payloads: 374 of 374 classified events name a
 *      resource the hub holds, so this costs the real signal nothing.
 *   3. THE WINDOW IS SHORT, AND STARTS WHEN ARYEO STARTS. 24 hours from the
 *      first post after arming (see PROBATION_HOURS).
 *   4. ONCE PER CUTOVER. autoHeldAt survives a re-arm, so the automatic disarm
 *      cannot be used repeatedly to keep enforcement off.
 *
 * What is left is a genuinely bounded trade: inside one 24-hour window, once,
 * something that can already see live Aryeo resource ids can push this lane back
 * to accepting — loudly, on the bell and in Slack. That is worth it to undo a
 * bad cutover in two minutes instead of eight days, and it is written down here
 * rather than hidden.
 */
export async function noteRefusalWhileArmed(provider: string, secret: string): Promise<boolean> {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") return false;
  const state = await readArmState(provider, secret);
  if (state.mode !== "armed" || !state.armedAt) return false;
  const armedAt = new Date(state.armedAt);
  if (Number.isNaN(armedAt.getTime())) return false;

  // The alarm runs whatever the gates below decide. A post being refused in the
  // hours after a cutover is news even when we are right to refuse it — on Sep 8
  // the office found out about 36 of them from nobody at all.
  const climbDown = await climbDownEvidence(provider, armedAt, state.autoHeldAt ?? null);
  await soundRefusalAlarm(provider, climbDown).catch(() => {});
  if (!climbDown.revert) return false;

  const reason = `${climbDown.genuine} refused ${provider} posts named jobs the hub already has, in the ${PROBATION_HOURS} hours after checking was switched on, and nothing verified in between — so something real is still posting here without the secret.`;
  await writeArm(provider, {
    ...state,
    mode: "holding",
    heldAt: new Date().toISOString(),
    heldBy: "the hub",
    heldReason: reason,
    autoHeldAt: new Date().toISOString(),
  });
  try {
    const { notifyInApp, opsAlert } = await import("@/lib/notify");
    await notifyInApp({
      kind: "system",
      title: `${provider === "aryeo" ? "Aryeo" : provider} events were bouncing — checking is off again`,
      body: "Real posts were refused just after verification was switched on, so the hub is accepting them again. Open Connections.",
      href: "/connections",
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `whhold-${provider}-${new Date().toISOString().slice(0, 13)}`,
    });
    await opsAlert(`⚠️ ${provider}: real posts started bouncing right after webhook checking was switched on, so the hub has switched it back off and is accepting them again. ${appBase()}/connections`);
  } catch {
    /* the climb-down stands whether or not anyone is told */
  }
  return true;
}

type ClimbDown = { revert: boolean; genuine: number; why: string };

/** Gates 1–4, measured. Separated from the writing so the reasoning is readable
 *  in one piece and so the alarm can say WHICH gate held. */
async function climbDownEvidence(provider: string, armedAt: Date, autoHeldAt: string | null): Promise<ClimbDown> {
  if (autoHeldAt) {
    return { revert: false, genuine: 0, why: "the hub has already switched checking off by itself once for this secret" };
  }
  try {
    // GATE 1 — has anything verified since the cutover?
    // Accepted AND not stamped "UNSIGNED". While armed the two are the same
    // thing, but a lane that was switched off and back on again inside this
    // window would have unsigned acceptances sitting in it, and counting one of
    // those as proof the feed works would veto a climb-down that should happen.
    const verified = await prisma.webhookEvent.count({
      where: {
        provider,
        status: { in: ["RECEIVED", "PROCESSED", "ERROR", "FAILED"] },
        createdAt: { gte: armedAt },
        OR: [{ error: null }, { NOT: { error: { startsWith: "UNSIGNED" } } }],
      },
    });
    if (verified > 0) {
      return {
        revert: false,
        genuine: 0,
        why: `${provider} has delivered ${verified} post${verified === 1 ? "" : "s"} that verified since checking was switched on, so the feed itself is working`,
      };
    }

    // GATE 3 — the window runs from the first post AFTER arming, not the press.
    const first = await prisma.webhookEvent.findFirst({
      where: { provider, createdAt: { gte: armedAt } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    // The refusal that brought us here is already written, so `first` is never
    // null in practice; treat a missing one as "not yet started" rather than
    // reaching for Date.now() and inventing a window.
    if (!first) return { revert: false, genuine: 0, why: "nothing has arrived since checking was switched on" };
    if (Date.now() - first.createdAt.getTime() > PROBATION_HOURS * 3600_000) {
      return { revert: false, genuine: 0, why: `the ${PROBATION_HOURS}-hour settling-in window has passed` };
    }

    // GATE 2 — count only refusals that name a job we already hold.
    const rows = await prisma.webhookEvent.findMany({
      where: { provider, status: "REJECTED", createdAt: { gte: armedAt } },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { payload: true },
    });
    let genuine = 0;
    for (const r of rows) {
      let body: Record<string, unknown> = {};
      try {
        body = r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {};
      } catch {
        continue; // unparseable body is not evidence of a real delivery
      }
      if (await refusalNamesKnownResource(body)) genuine++;
      if (genuine >= PROBATION_REFUSALS) break;
    }
    if (genuine < PROBATION_REFUSALS) {
      return {
        revert: false,
        genuine,
        why: `${genuine} of the last refusals named a job the hub already has (it takes ${PROBATION_REFUSALS})`,
      };
    }
    return { revert: true, genuine, why: "real deliveries are bouncing" };
  } catch {
    // Can't measure — leave enforcement exactly as it is. A disarm is the one
    // decision that must never be reached by a query falling over.
    return { revert: false, genuine: 0, why: "couldn't check the evidence" };
  }
}

/**
 * Refusals right after a cutover are news whether or not we act on them — the
 * Sep 8 outage was 36 of these that nobody heard about, and the case this is
 * really for is the quiet one: Aryeo's first post back is unsigned, it retries
 * twice, gives up, and without a word here nothing would be said until the
 * silence alarm 32 hours later.
 *
 * The AppSetting insert is the GATE, not an afterthought, and it comes first.
 * This runs on an unauthenticated path: anyone who knows the URL can make the
 * hub reach this line as often as they like, and "alert, then dedupe" would
 * turn each of those requests into a bell write and a Slack call. One indexed
 * primary-key insert that fails fast on conflict is the whole rate limit, and
 * exactly one instance wins it per hour.
 */
async function soundRefusalAlarm(provider: string, c: ClimbDown): Promise<void> {
  if (c.revert) return; // the climb-down has its own, louder message
  const hour = new Date().toISOString().slice(0, 13);
  try {
    await prisma.appSetting.create({ data: { key: `whrefuse-slack-${provider}-${hour}`, value: "sent" } });
  } catch {
    return; // already said this hour
  }
  const name = provider === "aryeo" ? "Aryeo" : provider;
  const { notifyInApp, opsAlert } = await import("@/lib/notify");
  await notifyInApp({
    kind: "system",
    title: `${name} posts are being refused`,
    body: `Checking is on and a post didn't match the saved secret. ${c.genuine > 0 ? "It looked like a real delivery. " : ""}Open Connections — you can switch checking off there.`.slice(0, 140),
    href: "/connections",
    targets: [{ roles: ["OWNER", "ADMIN"] }],
    dedupeKey: `whrefuse-${provider}-${hour}`,
  });
  await opsAlert(
    `⚠️ ${name}: a post was refused while webhook checking is on — ${c.why}. The hub is NOT switching checking off by itself. ${appBase()}/connections`,
  );
}

/** Could this payload be the proof that the provider is signing? Classifies as a
 *  real resource AND names it. The signature has already passed at this point,
 *  so this only has to rule out a signed health check or empty body — it is not
 *  load-bearing against an attacker, who would need the secret to get here. */
async function armWorthyPayload(payload: Record<string, unknown>): Promise<boolean> {
  const cls = await classifyPayload(payload);
  return Boolean(cls && cls.object && cls.id && UUID_RE.test(cls.id));
}

/**
 * Could this REFUSED payload only have come from something that really receives
 * Aryeo's deliveries? It has to name an order, listing, appointment or customer
 * the hub already holds. Nothing here trusts the body beyond its id, and the
 * lookups are by unique/indexed Aryeo id.
 */
async function refusalNamesKnownResource(payload: Record<string, unknown>): Promise<boolean> {
  const cls = await classifyPayload(payload);
  const id = cls?.id;
  if (!cls || !cls.object || !id || !UUID_RE.test(id)) return false;
  try {
    switch (cls.object) {
      case "ORDER":
        return Boolean(await prisma.project.findFirst({ where: { aryeoOrderId: id }, select: { id: true } }));
      case "LISTING":
        return Boolean(await prisma.project.findFirst({ where: { aryeoListingId: id }, select: { id: true } }));
      case "APPOINTMENT":
        return Boolean(await prisma.appointment.findFirst({ where: { aryeoId: id }, select: { id: true } }));
      case "CUSTOMER":
        return Boolean(await prisma.client.findFirst({ where: { aryeoCustomerId: id }, select: { id: true } }));
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** The receiver's own classifier, so there is one definition of "an Aryeo
 *  event" — loaded dynamically because the route imports this module and a
 *  static import back would be a cycle. */
async function classifyPayload(payload: Record<string, unknown>) {
  try {
    const { classifyAryeoPayload } = await import("@/app/api/webhooks/aryeo/route");
    return classifyAryeoPayload(payload);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// THE TWO BUTTONS
// ---------------------------------------------------------------------------

/** "Start checking now" — the office asserts the provider has the secret without
 *  waiting for a post to prove it. The settling-in window restarts with it (it
 *  is measured from the first post AFTER this moment), but autoHeldAt does not:
 *  the hub's one automatic climb-down per cutover stays spent, so re-arming
 *  cannot be used to hand out another one. */
export async function armNow(provider: string, secret: string, by?: string | null): Promise<void> {
  const state = await readArmState(provider, secret);
  await writeArm(provider, {
    v: 1,
    mode: "armed",
    fingerprint: armFingerprint(secret),
    watchingSince: state.watchingSince,
    armedAt: new Date().toISOString(),
    armedBy: by ?? "an owner",
    proof: state.proof ?? null,
    autoHeldAt: state.autoHeldAt ?? null,
  });
}

/** "Stop checking" — the escape hatch. Goes to HOLDING, not WATCHING, so the
 *  next good post cannot silently re-arm the thing that just broke. */
export async function holdEnforcement(provider: string, secret: string, by?: string | null, reason?: string): Promise<void> {
  const state = await readArmState(provider, secret);
  await writeArm(provider, {
    ...state,
    mode: "holding",
    fingerprint: armFingerprint(secret),
    heldAt: new Date().toISOString(),
    heldBy: by ?? "an owner",
    heldReason: reason ?? "Switched off by hand on Connections.",
  });
}

/** Start the clock on a newly saved or generated secret: watching, unproved. */
export async function beginWatching(provider: string, secret: string): Promise<void> {
  await writeArm(provider, freshRecord(armFingerprint(secret)));
}

/** Forget every decision about this provider — used when the secret itself is
 *  retired, so no stale record survives the credential it described. */
export async function forgetArmState(provider: string): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: armKey(provider) } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// THE HUMAN HALF — the URL, the events, and a message Jordan can just send
// ---------------------------------------------------------------------------

/** Where Aryeo must post. Built from the one origin helper (lib/appUrl), never
 *  typed by hand: the hub moved to hub.realtourpilot.com on 2 Sep 2026 and a
 *  literal host here is how you end up registering the old one. */
export function aryeoEndpointUrl(): string {
  return `${appBase()}/api/webhooks/aryeo`;
}

/** The subscriptions this hub actually routes (see processAryeoEvent). Listed
 *  for Aryeo support in the message below so nothing is enabled by guesswork. */
export const ARYEO_EVENTS = [
  "ORDER_CREATED",
  "ORDER_FULFILLED",
  "ORDER_PAID",
  "LISTING_UPDATED",
  "APPOINTMENT_SCHEDULED",
  "APPOINTMENT_ASSIGNED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELED",
  "CUSTOMER_CREATED",
  "CUSTOMER_UPDATED",
] as const;

/**
 * A complete message for Aryeo support, ready to send.
 *
 * The signing secret is NOT in it, on purpose. It is the entire authentication
 * for this endpoint, and a support ticket is a long-lived record in someone
 * else's system. The message asks where to enter it instead — and if support
 * says they need it, the copy box on screen is right there.
 *
 * It also asks them to remove stale endpoints. The hub changed address on
 * 2 September; an older subscription still pointing at the *.vercel.app host
 * would keep posting to a URL that does not have the new secret, which is
 * precisely the "some subscriptions signed, some not" case that makes a
 * cutover flap.
 */
export function aryeoSupportMessage(opts: { url: string; silentSince: Date | null }): string {
  const since = opts.silentSince ? etMonthDay(opts.silentSince) : null;
  return [
    "Hi Aryeo team,",
    "",
    "I'd like to set up (or re-enable) the webhook endpoint for our account.",
    "",
    "Endpoint URL:",
    opts.url,
    "",
    "Events we need:",
    ARYEO_EVENTS.join(", "),
    "",
    "Two things I'd like to sort out at the same time:",
    "",
    "1) Please make sure this endpoint is signed. Your documentation says any",
    "   arbitrary string can be used as the signing secret, and that the",
    "   signature arrives in the Signature header as an HMAC SHA-256 of the",
    "   request body. I already have a secret generated at my end. If I can",
    "   enter it myself in the dashboard, please point me to where. If you need",
    "   it from me, tell me the best way to send it to you.",
    "",
    // The one round trip this message exists to prevent. Aryeo's docs offer
    // custom headers as well as signing, and their support may only be able to
    // do the header — without this line Jordan has to write a second email,
    // which is the single thing the card promises he will never have to do.
    "   If signing the body isn't something you can switch on for us, a fixed",
    "   custom header works too — please send the secret as a header named",
    `   ${RECOMMENDED_TOKEN_HEADER}, and let me know that is what you've done.`,
    "",
    "2) We moved to a new web address on 2 September. Please remove any older",
    "   webhook endpoint on our account that still points at a vercel.app",
    "   address, so we are not posting to two different places.",
    "",
    since
      ? `Our live feed has been silent since ${since}, so I'd really appreciate you getting this switched back on as soon as you can.`
      : "I'd appreciate you getting this switched on as soon as you can.",
    "",
    "Thank you,",
    "Jordan Spackman",
    "RealTour Pilot",
  ].join("\n");
}
