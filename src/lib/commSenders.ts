import "server-only";
import { prisma } from "@/lib/prisma";
import { getSetting, putSetting } from "@/lib/settings";
import { OpenPhone, type OpUser } from "@/lib/integrations/openphone";

// ---------------------------------------------------------------------------
// WHO ON OUR SIDE WROTE THIS TEXT.
//
// Jordan, Sep 21 2026: "make sure we track Kyle's responses in OpenPhone and
// automatically send him coaching based on his responses." Nothing in that
// sentence is buildable until the hub can tell Kyle's words from Jordan's, and
// until today it could not: Kyle's handset IS the company OpenPhone line, so
// every outbound text from it was logged with contactName "Us" and nothing
// else. Measured on production Sep 21: 481 of the last 639 outbound texts (30
// days) are source=openphone contactName="Us". Coaching built on that would
// eventually coach the wrong person, which is worse than not coaching at all.
//
// This module turns OpenPhone's own `userId` into a TeamMember id, and refuses
// to answer whenever it cannot be certain. NULL MEANS UNKNOWN, NEVER "NOBODY".
//
// ===== WHAT THE LIVE DATA SAYS (probed Sep 21 2026, 1,528 stored payloads) ===
//
// 1. userId is on INBOUND events too, and there it is a LIE for our purposes.
//    All 730 stored `message.received` / direction=incoming payloads carry
//    userId=USpH7KOGFi — the workspace OWNER — because that field names the
//    OpenPhone user whose inbox the message landed in, not the person who typed
//    it. Read naively, every client text in the company would be attributed to
//    Jordan. The API read-back agrees and is cleaner about it: GET /messages
//    omits `userId` entirely on incoming rows. So: userId is trusted ONLY when
//    OpenPhone's own direction is "outgoing", and only when the message came
//    FROM the workspace line.
//
// 2. A teammate texting a client from their OWN handset arrives stamped
//    direction=incoming, so its userId is the inbox owner again, not the
//    teammate. Those rows are already named correctly from the phone roster
//    (the webhook's `sender?.name`), so nothing is lost by refusing them here.
//
// 3. The hub's API key belongs to Jordan. Every automated send the hub makes
//    comes back stamped userId=USpH7KOGFi: 51 auto-confirmation, 27
//    auto-delivery, 9 auto-afterhours, 2 auto-welcome in 30 days. Attributing
//    those to a human would put 89 machine-written texts into his coaching
//    report. So a row the hub composed is never given a person — see
//    isAttributableSource and hubComposedProviderId below. The same key is why
//    a row the hub SENT for a person must record the person from the signed-in
//    session and mark itself with HUB_SENT_SENDER_ID, or the echo names Jordan
//    on somebody else's sentence.
//
// 4. There are exactly two OpenPhone users and both match the roster by email:
//    US2XwAkbHK hello@realtourpilot.com (Kyle Smith) and USpH7KOGFi
//    info@realtourpilot.com (Jordan Spackman). Over 30 days of outbound
//    messages the split is 367 / 286, which is the proof that on an OUTGOING
//    event this field really is the sender and not a constant.
// ---------------------------------------------------------------------------

/**
 * THE SENTINEL THAT SAYS "THE PROVIDER'S ID ON THIS ROW IS NOT EVIDENCE."
 *
 * Added Sep 21 2026, the same evening, after the first adversarial pass found
 * the hole this module left open. Every send the hub makes itself — the Replies
 * rail, the inbox thread, the /shoot status text, the billing nudge, the
 * tasks send panel — goes out through the OpenPhone API KEY, and that key
 * belongs to Jordan. OpenPhone's delivery echo therefore comes back carrying
 * HIS user id no matter who pressed the button. Measured: 89 of 89 known hub
 * sends carry USpH7KOGFi and 0 carry Kyle's. Without this marker the echo
 * stamps Jordan onto a reply Kyle typed, and the task full-view then prints
 * "Jordan Spackman" above Kyle's words. That is WORSE than the "Us" the hub
 * wrote before this feature existed: "Us" claimed nothing, this claims a name
 * and gets it wrong.
 *
 * SOME hub send rails mark their own row through stampCommActor, and where they
 * do, the invariant that falls out is one line long and checkable in SQL:
 *
 *   senderUserId = "hub-sent"  ⇒  the hub sent it; OpenPhone's userId on the
 *                                 echo names the API key's owner, not the
 *                                 author, and must never be read or stored.
 *   any other senderUserId     ⇒  a real provider id, from a handset.
 *
 * It is deliberately not a real OpenPhone id (those are "US…"), and
 * resolveSenderTeamMemberId refuses it outright, so a later pass that tries to
 * re-resolve the column cannot turn it into a person.
 *
 * WHAT CHANGED THE SAME EVENING (third pass): the seven rails that do NOT mark
 * their row are no longer a hole, because the marker stopped being the thing
 * that protects them. The positive-evidence rule below refuses the API key
 * owner's id at the resolver, so an unmarked rail's echo names nobody instead of
 * naming Jordan. This sentinel is now a nice-to-have that records WHY a row is
 * unattributed, not the load-bearing guard it was asked to be.
 */
export const HUB_SENT_SENDER_ID = "hub-sent";

// ---------------------------------------------------------------------------
// THE POSITIVE-EVIDENCE RULE (Sep 21 2026, third pass) — READ THIS FIRST.
//
// The two passes before this one tried to close the hole rail by rail: every
// place that sends through OpenPhone.sendMessage would read the session, log its
// row and stamp the actor. Four rails were fixed, and the reviewers then found
// SEVEN MORE doing exactly the same thing (sendReplyForTask in /today,
// sendClientText behind the AskHub draft card, sendDeliveryText and
// sendConfirmationText on the to-do, and others). Chasing rails was not
// converging, and the next rail somebody adds re-opened it every time.
//
// So the rule moved here, to the one place the provider's echo is read, and it
// is stated in terms of what the echo can PROVE rather than what a rail
// remembered to do:
//
//   · userId = SOMEBODY OTHER THAN THE API KEY'S OWNER is unambiguous. The key
//     can only ever send as its own owner, so a message stamped with Kyle's
//     OpenPhone id can only have come from Kyle's handset. Attribute it. This is
//     where the volume is: 365 of the last 30 days' outbound rows are his by
//     this rule.
//
//   · userId = THE API KEY'S OWNER is AMBIGUOUS, and stays ambiguous forever.
//     It means either Jordan typed it on his handset or the hub sent it through
//     the API, and OpenPhone cannot tell us which. So the echo ALONE never
//     attributes it. Only separate, positive evidence may: a session that
//     recorded who pressed Send (stampCommActor), an outbox row, or a CommLog
//     row that existed before the echo arrived. With no such evidence the row
//     stays NULL, which means UNKNOWN.
//
// WHAT THIS COSTS, said plainly because it is a real cost: Jordan's own
// handset-typed texts from the workspace line become unattributable. He is not
// the one being coached, and inventing an attribution for him is precisely the
// failure mode this feature exists to avoid. MEASURED, Sep 21, on the 587
// outbound texts of the last 30 days that carry a provider id: 365 are named
// (all Kyle, through his own OpenPhone id), 89 are refused by the source
// allow-list, 17 have no trusted payload, and 116 carry the key owner's id and
// now stay UNKNOWN. Exactly 1 of those 116 can be proved a hub send from the
// row's own timing, so up to 115 really are Jordan's handset and really do lose
// a name. Before this feature every one of them said "Us" and claimed nothing.
//
// WHY IT IS BETTER THAN STAMPING RAILS: it needs no cooperation from any send
// rail, it cannot be undone by adding a new one, and it is one predicate to
// test (echoIdentifiesAuthor). The eighth rail somebody writes next month is
// safe by default. The per-rail session stamps stay, because a session is
// BETTER evidence than the echo, but nothing depends on a rail remembering.
// ---------------------------------------------------------------------------

/**
 * Who the hub's OpenPhone API key sends as. Learned, never assumed — see
 * apiKeySenderUserId below. Shape: { userId, at, how }.
 */
export const API_KEY_SENDER_SETTING = "openphone_api_key_user";

/** Cached provider-user → TeamMember resolution. Rebuilt from /users on miss. */
export const SENDER_MAP_SETTING = "openphone_sender_map";
/**
 * Hand pins, and they WIN over the automatic match. Jordan needs to be able to
 * say "this OpenPhone user is Kyle" without a deploy — a shared login, a
 * renamed seat or a roster email that never matched would otherwise leave a
 * real person permanently unattributed. Shape: { "<providerUserId>": "<teamMemberId>" },
 * and the empty string means "deliberately nobody" (stays unattributed).
 */
export const SENDER_OVERRIDE_SETTING = "openphone_sender_overrides";

/** Six hours: the OpenPhone roster changes a few times a year, not a day. */
const MAP_TTL_MS = 6 * 60 * 60 * 1000;

type SenderMap = {
  /** ISO time of the last SUCCESSFUL /users read. */
  at: string;
  /** provider user id → TeamMember id, or null when we could not say. */
  byUserId: Record<string, string | null>;
  /** provider user id → a human label, for the report and the settings screen. */
  labels: Record<string, string>;
};

const EMPTY_MAP: SenderMap = { at: "", byUserId: {}, labels: {} };

type Overrides = { byUserId: Record<string, string> };
const EMPTY_OVERRIDES: Overrides = { byUserId: {} };

/** Per-lambda cache so a burst of webhooks does not re-read the setting row. */
let memo: { at: number; map: SenderMap } | null = null;

const norm = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Match one OpenPhone user to a TeamMember. Email first (exact, case-folded),
 * then full name. NEVER GUESSES: no match and more-than-one match both resolve
 * to null. Inactive members are matchable on purpose — a text Kyle sent is
 * still Kyle's the day after he leaves, and dropping him would silently
 * re-attribute his history to nobody.
 */
function matchOne(
  u: OpUser,
  team: { id: string; name: string; email: string | null }[],
): string | null {
  const email = norm(u.email);
  if (email) {
    const hits = team.filter((t) => norm(t.email) === email);
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) return null; // ambiguous roster — say nothing
  }
  const full = norm([u.firstName, u.lastName].filter(Boolean).join(" "));
  if (full) {
    const hits = team.filter((t) => norm(t.name) === full);
    if (hits.length === 1) return hits[0].id;
  }
  return null;
}

function labelOf(u: OpUser): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return name || u.email || u.id;
}

/**
 * The whole matching rule, with no I/O, so it can be exercised against the real
 * roster without writing anything. Exported for the drill.
 */
export function matchOpUsers(
  users: OpUser[],
  team: { id: string; name: string; email: string | null }[],
): { byUserId: Record<string, string | null>; labels: Record<string, string> } {
  const byUserId: Record<string, string | null> = {};
  const labels: Record<string, string> = {};
  for (const u of users) {
    if (!u.id) continue;
    byUserId[u.id] = matchOne(u, team);
    labels[u.id] = labelOf(u);
  }
  return { byUserId, labels };
}

/**
 * Rebuild the map from the live roster. Returns null if OpenPhone did not
 * answer — the caller then keeps whatever it already had and, if it has
 * nothing, attributes nobody. A failed API call must never invent a sender.
 */
async function rebuild(): Promise<SenderMap | null> {
  let users: OpUser[];
  try {
    users = await OpenPhone.users();
  } catch (e) {
    console.warn("[commSenders] OpenPhone /users unavailable — attribution stays unresolved:", e instanceof Error ? e.message : e);
    return null;
  }
  if (users.length === 0) return null;

  const team = await prisma.teamMember.findMany({ select: { id: true, name: true, email: true } });
  const map: SenderMap = { at: new Date().toISOString(), ...matchOpUsers(users, team) };
  await putSetting(SENDER_MAP_SETTING, map, "commSenders").catch(() => {
    /* the cache is an optimisation; a failed write just means we re-read next time */
  });
  return map;
}

async function senderMap(opts: { refresh?: boolean } = {}): Promise<SenderMap> {
  if (!opts.refresh && memo && Date.now() - memo.at < MAP_TTL_MS) return memo.map;

  const stored = await getSetting<SenderMap>(SENDER_MAP_SETTING, EMPTY_MAP);
  const age = stored.at ? Date.now() - Date.parse(stored.at) : Number.POSITIVE_INFINITY;
  if (!opts.refresh && Number.isFinite(age) && age < MAP_TTL_MS) {
    memo = { at: Date.now(), map: stored };
    return stored;
  }

  const fresh = await rebuild();
  // OpenPhone down: keep serving the stored map rather than going blind. It is
  // the last thing the provider actually told us, not a guess.
  const map = fresh ?? stored;
  memo = { at: Date.now(), map };
  return map;
}

/**
 * The provider's user id → a TeamMember id, or null when we cannot say.
 * Overrides are consulted BEFORE the automatic match, and an override of ""
 * means "leave this one unattributed on purpose".
 */
export async function resolveSenderTeamMemberId(userId: string | null | undefined): Promise<string | null> {
  const id = (userId ?? "").trim();
  if (!id) return null;
  // The sentinel is not a person and never becomes one. Refused here rather
  // than only at the write site so a future backfill that re-resolves the
  // column cannot quietly turn every hub send into the API key's owner.
  if (id === HUB_SENT_SENDER_ID) return null;

  const overrides = await getSetting<Overrides>(SENDER_OVERRIDE_SETTING, EMPTY_OVERRIDES);
  const pinned = overrides.byUserId?.[id];
  if (typeof pinned === "string") {
    if (!pinned) return null; // deliberately nobody
    const exists = await prisma.teamMember.findUnique({ where: { id: pinned }, select: { id: true } }).catch(() => null);
    return exists?.id ?? null; // a pin at a deleted member is not an attribution
  }

  const map = await senderMap();
  if (id in map.byUserId) return map.byUserId[id];

  // A user id we have never seen (a new seat since the last refresh) — one
  // refresh, then take the answer, whatever it is.
  const fresh = await senderMap({ refresh: true });
  return fresh.byUserId[id] ?? null;
}

// ---------------------------------------------------------------------------
// WHICH ROWS MAY CARRY A PERSON AT ALL
// ---------------------------------------------------------------------------

/**
 * An ALLOW-list, not a deny-list, and deliberately so: when somebody adds a new
 * automated text rail next month it will default to unattributed rather than
 * quietly landing in a person's coaching report. "openphone" is the source the
 * receiver stamps on a text a human typed on the line. Everything else —
 * auto-confirmation, auto-delivery, auto-afterhours, auto-welcome, upload-nag,
 * upload-digest, upload-intro, hub-reply — is the hub's own words or a record
 * that answers nobody.
 */
export function isAttributableSource(source: string | null | undefined): boolean {
  return source === "openphone";
}

/**
 * THE WEBHOOK GATE, as a pure function, so the drill exercises the shipped rule
 * instead of a transcription of it. The first review found the drill had copied
 * these four conditions out of the receiver by hand; the numbers were right, but
 * it would have kept passing if the receiver's copy ever drifted.
 *
 * All four conditions are load-bearing:
 *  · a message event — call payloads carry `answeredBy` (who picked up), never
 *    an author, so 142 of them are refused outright rather than guessed at;
 *  · OpenPhone's OWN direction is outgoing — on an incoming payload `userId`
 *    names the inbox owner, and all 730 retained ones carry Jordan's id;
 *  · it came FROM the workspace line — a teammate's own handset arrives stamped
 *    "incoming" and is already named from the phone roster;
 *  · there is a userId and a message id to hang it on.
 */
export function payloadIsAttributable(input: {
  eventType: string;
  /** OpenPhone's own `data.object.direction`, not the hub's effective one. */
  direction: string;
  /** True when the message came from the workspace line. */
  fromWorkspaceLine: boolean;
  senderUserId: string | null | undefined;
  messageId: string | null | undefined;
}): boolean {
  if (!input.eventType.startsWith("message.")) return false;
  if (!input.direction.toLowerCase().startsWith("out")) return false;
  if (!input.fromWorkspaceLine) return false;
  if (!(input.senderUserId ?? "").trim()) return false;
  if (!(input.messageId ?? "").trim()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// WHICH PROVIDER ID IS EVIDENCE AND WHICH ONE IS AMBIGUOUS
// ---------------------------------------------------------------------------

type ApiKeySender = {
  /** The OpenPhone user the API key sends as, or null while we cannot say. */
  userId: string | null;
  /** ISO time of the last answer, so a miss is not re-derived on every event. */
  at: string;
  /** pinned = a human said so and it outranks everything we observe. */
  how: "pinned" | "learned" | "derived" | "none";
};
const EMPTY_API_KEY_SENDER: ApiKeySender = { userId: null, at: "", how: "none" };
/** A key changes hands when somebody rotates it, which is a yearly event. */
const API_KEY_SENDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Not knowing yet is the expensive state, so re-look far more often. */
const API_KEY_SENDER_MISS_TTL_MS = 6 * 60 * 60 * 1000;

let apiKeyMemo: { at: number; value: string | null } | null = null;
const apiKeyTtl = (v: string | null) => (v ? API_KEY_SENDER_TTL_MS : API_KEY_SENDER_MISS_TTL_MS);

/**
 * THE RULE, with no I/O, so the drill exercises the shipped predicate instead of
 * a transcription of it (the first review caught the drill copying the webhook
 * gate out by hand, and a copy goes on passing after the original drifts).
 *
 * True only when the provider's id is POSITIVE evidence of who wrote the words.
 * Note what makes it false, and that the default is silence:
 *  · no id at all;
 *  · our own sentinel, which is a marker and never a person;
 *  · WE DO NOT YET KNOW which id the key sends as — then every id is possibly
 *    the ambiguous one, so none of them is evidence;
 *  · the id IS the key's owner, which is the whole point.
 */
export function echoIdentifiesAuthor(
  senderUserId: string | null | undefined,
  apiKeyUserId: string | null,
): boolean {
  const id = (senderUserId ?? "").trim();
  if (!id) return false;
  if (id === HUB_SENT_SENDER_ID) return false;
  if (!apiKeyUserId) return false;
  return id !== apiKeyUserId;
}

/**
 * Which OpenPhone user the API key sends as, decided from messages WE KNOW the
 * hub sent. An OutboxMessage with a providerId is the hub's own record that it
 * handed that message to the API, so the userId on that message's echo is, by
 * definition, the key's owner. Pure, so the drill can run it read-only.
 *
 * Unanimity is required. Two different ids across hub sends means the key
 * changed hands inside the window (or the outbox match is wrong), and a wrong
 * answer here is worse than no answer: it would silence the real sender and let
 * the ambiguous one through. Not unanimous, say nothing.
 */
export function pickApiKeySenderUserId(
  echoes: { messageId: string; userId: string; direction: string }[],
  hubSentProviderIds: ReadonlySet<string>,
): string | null {
  const seen = new Set<string>();
  for (const e of echoes) {
    if (!hubSentProviderIds.has(e.messageId)) continue;
    if (!e.direction.toLowerCase().startsWith("out")) continue;
    const id = e.userId.trim();
    if (!id || id === HUB_SENT_SENDER_ID) continue;
    seen.add(id);
  }
  return seen.size === 1 ? [...seen][0] : null;
}

/**
 * Bootstrap: read the answer out of evidence already on file, rather than
 * waiting for the next hub send to teach it. Bounded on purpose — the delivered
 * echoes are ~750 bytes each and the outbox holds 54 rows all time, so 400 is
 * about six days of messages and costs a few hundred KB, once a week.
 */
async function deriveApiKeySender(): Promise<string | null> {
  const outbox = await prisma.outboxMessage
    .findMany({ where: { providerId: { not: null } }, select: { providerId: true } })
    .catch(() => [] as { providerId: string | null }[]);
  const ids = new Set(outbox.map((o) => o.providerId).filter((v): v is string => !!v));
  if (ids.size === 0) return null;

  const events = await prisma.webhookEvent
    .findMany({
      where: { provider: "openphone", eventType: "message.delivered" },
      orderBy: { createdAt: "desc" },
      take: 400,
      select: { payload: true },
    })
    .catch(() => [] as { payload: string }[]);

  const echoes: { messageId: string; userId: string; direction: string }[] = [];
  for (const ev of events) {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(ev.payload ?? "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    const d = ((p.data as Record<string, unknown>)?.object ?? p.data ?? p) as Record<string, unknown>;
    echoes.push({
      messageId: typeof d.id === "string" ? d.id : "",
      userId: typeof d.userId === "string" ? d.userId : "",
      direction: String(d.direction ?? ""),
    });
  }
  return pickApiKeySenderUserId(echoes, ids);
}

/**
 * The cached answer. Null means "we cannot say yet", and null makes the echo
 * attribute NOBODY — the conservative direction, and the one Kyle's coaching
 * report can survive for a day. It will not be null for long: the sweeps put
 * roughly one client text a day through the outbox, and noteApiKeySender learns
 * from each one.
 */
export async function apiKeySenderUserId(): Promise<string | null> {
  if (apiKeyMemo && Date.now() - apiKeyMemo.at < apiKeyTtl(apiKeyMemo.value)) return apiKeyMemo.value;

  const stored = await getSetting<ApiKeySender>(API_KEY_SENDER_SETTING, EMPTY_API_KEY_SENDER);
  const remember = (value: string | null) => {
    apiKeyMemo = { at: Date.now(), value };
    return value;
  };
  // A hand pin is a human saying which seat owns the key. It is never
  // re-derived and never overwritten by what we observe.
  if (stored.how === "pinned") return remember(stored.userId || null);

  const age = stored.at ? Date.now() - Date.parse(stored.at) : Number.POSITIVE_INFINITY;
  if (Number.isFinite(age) && age < apiKeyTtl(stored.userId || null)) return remember(stored.userId || null);

  const derived = await deriveApiKeySender();
  // A scan that came up empty must not FORGET a previous answer. Losing it
  // would re-open the ambiguous id, which is the one failure that names a
  // person wrongly; keeping a stale one only costs silence on a rotated key.
  const next: ApiKeySender = derived
    ? { userId: derived, at: new Date().toISOString(), how: "derived" }
    : { userId: stored.userId ?? null, at: new Date().toISOString(), how: stored.userId ? stored.how : "none" };
  await putSetting(API_KEY_SENDER_SETTING, next, "commSenders").catch(() => {
    /* the cache is an optimisation; a failed write just means we derive again */
  });
  return remember(next.userId);
}

/**
 * Learn the key's owner from one message the hub definitely sent (the caller has
 * already checked the outbox). Cheap, idempotent, and self-healing: rotate the
 * key to a different seat and the next hub send re-teaches it within the hour,
 * with no deploy and no settings screen.
 */
export async function noteApiKeySender(userId: string | null | undefined): Promise<void> {
  const id = (userId ?? "").trim();
  if (!id || id === HUB_SENT_SENDER_ID) return;
  const stored = await getSetting<ApiKeySender>(API_KEY_SENDER_SETTING, EMPTY_API_KEY_SENDER);
  if (stored.how === "pinned") return;
  if (stored.userId === id) return;
  await putSetting(
    API_KEY_SENDER_SETTING,
    { userId: id, at: new Date().toISOString(), how: "learned" } satisfies ApiKeySender,
    "commSenders",
  ).catch(() => {});
  apiKeyMemo = { at: Date.now(), value: id };
}

/**
 * Provider message ids the HUB composed and queued (the outbox is the record of
 * every send the hub made itself). A second, independent guard behind
 * isAttributableSource: if a sweep's own CommLog write ever lost the race to
 * the webhook echo, the row would read source "openphone" and would otherwise
 * be attributed to whoever owns the API key — which is Jordan.
 */
export async function hubComposedProviderId(providerId: string): Promise<boolean> {
  if (!providerId) return false;
  const row = await prisma.outboxMessage
    .findFirst({ where: { providerId }, select: { id: true } })
    .catch(() => null);
  return row !== null;
}

// ---------------------------------------------------------------------------
// WRITING IT DOWN
// ---------------------------------------------------------------------------

/**
 * Stamp the sender onto an already-logged CommLog row, found by its provider
 * externalId. Kept here rather than in logComm so the attribution rules live in
 * one file with the evidence for them.
 *
 * Two invariants:
 *  • It NEVER overwrites an attribution that is already there, and it refuses
 *    any row that already carries a senderUserId — which includes every row a
 *    hub rail marked with HUB_SENT_SENDER_ID. The hub's own send path knows the
 *    signed-in person who pressed the button, the highest quality attribution
 *    there is, and this echo arrives seconds later carrying the API key's owner.
 *    (stampCommActor is allowed to overwrite in the other direction, for the
 *    rare case where this echo wins the race. A session always beats a key.)
 *  • It writes NOTHING at all to a row the hub composed, not even the raw
 *    senderUserId: a later reader that re-resolved that id itself would put 89
 *    machine-written texts a month into Jordan's name.
 *
 * THIRD INVARIANT, and the one that makes the other two stop depending on a
 * rail's good manners: it refuses the API key owner's id outright. See the
 * positive-evidence block at the top of this file. An echo carrying that id
 * cannot tell us whether Jordan typed it on his handset or the hub sent it for
 * somebody else, so it writes NOTHING — not even the raw provider id. Leaving
 * the ambiguous id in the column would be a landmine for the next reader who
 * re-resolves it, and the row is honestly unknown, not half known.
 *
 * Returns what it did, so a caller can log it.
 */
export async function stampCommSender(input: {
  externalId: string;
  /** OpenPhone's own user id, from an OUTGOING event only. */
  senderUserId: string | null;
}): Promise<"stamped" | "unresolved" | "ambiguous" | "skipped"> {
  const { externalId } = input;
  const userId = (input.senderUserId ?? "").trim();
  if (!externalId || !userId) return "skipped";

  const row = await prisma.commLog
    .findUnique({ where: { externalId }, select: { id: true, source: true, senderTeamMemberId: true, senderUserId: true } })
    .catch(() => null);
  if (!row) return "skipped";
  if (row.senderTeamMemberId || row.senderUserId) return "skipped"; // already settled, never re-decide
  if (!isAttributableSource(row.source)) return "skipped";

  // THE ECHO ALONE MAY NEVER NAME THE KEY'S OWNER. Checked before any other
  // work because it is the rule, and because it is a cached read while the
  // outbox check below is a query.
  if (!echoIdentifiesAuthor(userId, await apiKeySenderUserId())) return "ambiguous";

  const providerId = externalId.replace(/^op-/, "");
  if (await hubComposedProviderId(providerId)) return "skipped";

  const teamMemberId = await resolveSenderTeamMemberId(userId);
  // The raw id is stored either way: it is what the provider told us, it stays
  // true if the roster mapping changes, and it lets a later pass re-resolve a
  // person we could not name today WITHOUT guessing.
  await prisma.commLog.updateMany({
    where: { externalId, senderTeamMemberId: null },
    data: { senderUserId: userId, senderTeamMemberId: teamMemberId },
  });
  return teamMemberId ? "stamped" : "unresolved";
}

/**
 * WHO WROTE THE WORDS, from the hub's own send rails.
 *
 * Every rail that sends through the OpenPhone API key calls this immediately
 * after it logs its row, and it has to answer ONE question that no field on the
 * row can answer for it: did a person write these words, or did the hub?
 *
 * `wrote` is required and has no default, and the union below makes it a type
 * error to hand a person to the hub case. That is the whole point. The first
 * review found the confirmation/delivery panel naming Kyle on a row whose body
 * is the hub's own template — byte-identical, in the audit's eyes, to something
 * he typed — and he would have been coached on the hub's wording. Manufactured
 * criticism is the fastest way to prove the feature is not paying attention.
 * With this signature the next automated rail cannot land in somebody's
 * coaching report by leaving an argument off; it has to say "the person" in
 * writing, about words the person did not write.
 *
 * What gets written, and why:
 *  · ALWAYS the `hub-sent` sentinel in senderUserId. It is what stops the
 *    delivery echo — which carries the API key owner's id, Jordan's — from
 *    stamping the wrong name on a message somebody else typed. stampCommSender
 *    refuses any row that already has a senderUserId, so this closes the door
 *    permanently and without a join to the outbox.
 *  · The person in senderTeamMemberId ONLY for `wrote: "the person"`. Hub words
 *    keep senderTeamMemberId null. Null means UNKNOWN, and an unknown row is
 *    never coached — so the hub's own templates fall out of the audit on their
 *    own, with no cooperation needed from whoever writes it. A row that is
 *    positively hub-composed reads `senderUserId = "hub-sent" AND
 *    senderTeamMemberId IS NULL`: a column test, not a join.
 *  · Nothing at all when we cannot name the presser (no session, or an owner in
 *    "view as" — that preview is read-only and recording a send against the
 *    person being previewed would be a lie). The sentinel still goes down, so
 *    the row stays honestly unknown instead of drifting to Jordan.
 *
 * THE SESSION BEATS THE PROVIDER ECHO, even when the echo got here first. The
 * rails log their row and stamp it milliseconds later, but the delivery webhook
 * can in principle land in between; if it does, the row is already carrying the
 * API key owner's name and a stamp that only filled nulls would leave it there.
 * A signed-in session is the best evidence of authorship the hub will ever have,
 * so it overwrites, and it clears the provider id as it goes — that id belongs
 * to the key, not to the author, and leaving it next to a different person is a
 * landmine for anyone who re-resolves the column later.
 */
export type CommActorStamp = {
  /** The row to mark, by the `op-<message id>` the rail logged it under. */
  externalId: string | null | undefined;
} & (
  | {
      /** A signed-in person typed or edited these words and pressed Send. */
      wrote: "the person";
      /** Null when there is no session to name — the row then stays unknown. */
      teamMemberId: string | null | undefined;
    }
  | {
      /** The hub composed these words; a person only pressed Send. Never coached. */
      wrote: "the hub";
      teamMemberId?: never;
    }
);

export async function stampCommActor(input: CommActorStamp): Promise<"named" | "marked" | "nothing"> {
  const externalId = (input.externalId ?? "").trim();
  if (!externalId) return "nothing";

  const row = await prisma.commLog
    .findUnique({ where: { externalId }, select: { id: true, senderUserId: true, senderTeamMemberId: true } })
    .catch(() => null);
  // No row means the rail's own logComm lost or was deduped away. Nothing to
  // mark, and inventing one here would be a second record of the same text.
  if (!row) return "nothing";
  // Already settled as the hub's words — never re-decided, in either direction.
  if (row.senderUserId === HUB_SENT_SENDER_ID && !row.senderTeamMemberId) return "nothing";

  if (input.wrote === "the hub") {
    await prisma.commLog
      .update({ where: { id: row.id }, data: { senderUserId: HUB_SENT_SENDER_ID, senderTeamMemberId: null } })
      .catch(() => {});
    return "marked";
  }

  const teamMemberId = (input.teamMemberId ?? "").trim();
  await prisma.commLog
    .update({
      where: { id: row.id },
      data: { senderUserId: HUB_SENT_SENDER_ID, senderTeamMemberId: teamMemberId || null },
    })
    .catch(() => {});
  return teamMemberId ? "named" : "marked";
}

// ---------------------------------------------------------------------------
// FOR THE REPORT / SETTINGS SCREEN
// ---------------------------------------------------------------------------

export type SenderMapRow = {
  userId: string;
  label: string;
  teamMemberId: string | null;
  teamMemberName: string | null;
  pinned: boolean;
};

/** Who OpenPhone says works here, and who the hub thinks each one is. */
export async function senderMapRows(): Promise<{ rows: SenderMapRow[]; refreshedAt: string | null }> {
  const map = await senderMap();
  const overrides = await getSetting<Overrides>(SENDER_OVERRIDE_SETTING, EMPTY_OVERRIDES);
  const ids = [...new Set(Object.values(map.byUserId).filter((v): v is string => !!v).concat(Object.values(overrides.byUserId ?? {}).filter(Boolean)))];
  const team = ids.length
    ? await prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(team.map((t) => [t.id, t.name]));

  const rows: SenderMapRow[] = Object.keys(map.byUserId).map((userId) => {
    const pin = overrides.byUserId?.[userId];
    const teamMemberId = typeof pin === "string" ? (pin || null) : map.byUserId[userId];
    return {
      userId,
      label: map.labels[userId] ?? userId,
      teamMemberId,
      teamMemberName: teamMemberId ? nameById.get(teamMemberId) ?? null : null,
      pinned: typeof pin === "string",
    };
  });
  return { rows, refreshedAt: map.at || null };
}

/** Pin (or deliberately clear) one provider user's person. Owner/admin only — the caller guards. */
export async function setSenderOverride(userId: string, teamMemberId: string | null, by?: string | null): Promise<void> {
  const overrides = await getSetting<Overrides>(SENDER_OVERRIDE_SETTING, EMPTY_OVERRIDES);
  const next: Overrides = { byUserId: { ...(overrides.byUserId ?? {}) } };
  next.byUserId[userId] = teamMemberId ?? "";
  await putSetting(SENDER_OVERRIDE_SETTING, next, by ?? null);
  memo = null;
}
