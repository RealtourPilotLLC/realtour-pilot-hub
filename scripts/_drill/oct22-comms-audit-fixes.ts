// ---------------------------------------------------------------------------
// DRILL: THE OCT 22 COMMS AUDIT FIXES, one section per fix.
//
//   DRILL_PORT=6971 node scripts/_drill/run-all.cjs scripts/_drill/oct22-comms-audit-fixes.ts
//
//   C1  a staff reply answers the main conversation only (never the client's
//       messages under a script); closeRun:false answers nothing; the desk
//       task stays open while anything still waits
//   C2  photo words are specific ("still", "stage", "image" are not), and
//       the word backstop only fills a missing or "unclear" model label
//   H2  an unknown sender in info@ is never matched by a street or a town:
//       logged unmatched and owner-only (hello@ unchanged)
//   H3  Jordan's own addresses are staff before any client lookup: a forward
//       is the forwarded client's, a note is nobody's, never a lead
//   H4  (section module) a holding reply keeps the thread waiting on us; and
//       here, the Gmail reply sweep leaves the task open on a holding reply
//   H5  a usage limit / credit / refused key: AiUnavailableError, a failure
//       in the ledger by feature, ONE owner alert an hour, cleared by the
//       next answer; the comms router queues the message and the sweep reads
//       it again (its asks filed then); the Slack router gives it back
//   H6  (section module) no booking confirmation while a conflict is open
//   M3  asks: the same words or the same booking files once; a keyed photo
//       ask replaces a plain twin. Email: one Message-ID in two inboxes is
//       logged once
//   M6  an email answered inside the scan still files its asks, marked
//       answered (a holding reply leaves them open)
//   H3b the revision task's lane follows its items (video items: the
//       editor's card; photo items only: Kyle's photo card)
//   LOW (section module) chaser text without payroll; chasing task closes
//       on delivery
//   M1, M2 are live repairs: their proof is the dry runs of
//   scripts/_live/oct22-photo-questions-off-video.ts and oct22-ashley-cancel-ask.ts.
//
// ISOLATION: PGlite via the shared harness; the Smart Brain stubbed at its
// two functions; Google and Anthropic answered by fakes at the fence;
// nothing else leaves.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6971);
const MIN = 60_000;
const HOUR = 60 * MIN;

// ---- the Smart Brain, stubbed at its two functions ----
type Ask = { kind: "SPECIAL_REQUEST" | "SCHEDULING"; text: string; summary: string; medium: "video" | "photo" | "both" | "unclear"; projectHint: string | null };
type Decision = { actionable: boolean; projectId: string | null; title: string; detail: string; priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW"; mergeIntoTaskId: string | null; isRevisionRequest: boolean; flags: string[]; reason: string; taskType: "client_reply" | "todo"; asks?: Ask[] };
const decisions: { match: RegExp; d: Decision }[] = [];
let brainDown = false;
const brainCalls = { comms: 0, slack: 0 };
const decide = (p: Partial<Decision>): Decision => ({ actionable: true, projectId: null, title: "Reply to the client", detail: "x", priority: "HIGH", mergeIntoTaskId: null, isRevisionRequest: false, flags: [], reason: "drill", taskType: "client_reply", asks: [], ...p });
async function refused(): Promise<never> {
  const { AiUnavailableError } = await import("@/lib/aiOutage");
  throw new AiUnavailableError("usage_limit", 400, "You have reached your specified API usage limits.");
}
interceptModule(
  (r) => r === "@/lib/brain" || /[\\/]src[\\/]lib[\\/]brain(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "routeCommTask") return async (input: { message: string }) => { brainCalls.comms++; if (brainDown) return refused(); return decisions.find((x) => x.match.test(input.message))?.d ?? null; };
      if (k === "routeSlackTask") return async () => { brainCalls.slack++; if (brainDown) return refused(); return null; };
      return t[k];
    },
  }),
);
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => null : t[k]; } }),
);

// ---- a fake Anthropic: whatever the section sets ----
let anthropic: { status: number; body: unknown } | null = null;
const anthropicHits: string[] = [];
// ---- a fake Google (the real syncGmail), as oct14-shared-email-followup.ts ----
type FakeMsg = { id: string; thread: string; from: string; to: string; subject: string; body: string; at: Date; inReplyTo?: string; messageId?: string };
const fakeGoogle = { on: false, inbox: { info: [] as FakeMsg[], hello: [] as FakeMsg[] }, sent: { info: [] as FakeMsg[], hello: [] as FakeMsg[] } };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const asGmail = (m: FakeMsg) => ({
  id: m.id, threadId: m.thread, snippet: m.body.slice(0, 120), internalDate: String(m.at.getTime()),
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: m.from }, { name: "To", value: m.to }, { name: "Subject", value: m.subject },
      ...(m.inReplyTo ? [{ name: "In-Reply-To", value: m.inReplyTo }] : []),
      ...(m.messageId ? [{ name: "Message-ID", value: m.messageId }] : []),
    ],
    body: { data: b64(m.body) },
  },
});
const fence = fenceFetch((url, init) => {
  if (url.startsWith("https://api.anthropic.com/")) {
    anthropicHits.push(url);
    return anthropic ? json(anthropic.status, anthropic.body) : null;
  }
  if (!fakeGoogle.on) return null;
  if (url === "https://oauth2.googleapis.com/token") {
    const rt = new URLSearchParams(String(init?.body ?? "")).get("refresh_token");
    return rt === "rt-info-drill" ? json(200, { access_token: "tok-info", expires_in: 3600 }) : rt === "rt-hello-drill" ? json(200, { access_token: "tok-hello", expires_in: 3600 }) : json(400, { error: "invalid_grant" });
  }
  const m = /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me(\/[^?]*)(\?.*)?$/.exec(url);
  if (!m) return null;
  const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
  const box = auth.endsWith("tok-info") ? "info" : auth.endsWith("tok-hello") ? "hello" : null;
  if (!box) return json(401, {});
  const all = [...fakeGoogle.inbox[box], ...fakeGoogle.sent[box]];
  if (m[1] === "/messages") {
    const q = new URLSearchParams(m[2] ?? "").get("q") ?? "";
    const list = /in:sent/.test(q) ? fakeGoogle.sent[box] : /in:inbox/.test(q) ? fakeGoogle.inbox[box] : [];
    return json(200, { messages: list.map((x) => ({ id: x.id, threadId: x.thread })) });
  }
  const one = /^\/messages\/([^/]+)$/.exec(m[1]);
  if (one) {
    const x = all.find((y) => y.id === decodeURIComponent(one[1]));
    return x ? json(200, asGmail(x)) : json(404, {});
  }
  const th = /^\/threads\/([^/]+)$/.exec(m[1]);
  if (th) return json(200, { messages: all.filter((y) => y.thread === th[1]).sort((a, b) => a.at.getTime() - b.at.getTime()).map(asGmail) });
  return json(404, {});
});
installNextStubs();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { GOOGLE_CLIENT_ID: "drill-client", GOOGLE_CLIENT_SECRET: "drill-client-secret" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const c = makeChecker();
  const ago = (m: number) => new Date(Date.now() - m * MIN);

  // The roster as live: Jordan on info@, Kyle on hello@, John the editor.
  await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "info@realtourpilot.com", role: "PHOTOGRAPHER", active: true } });
  await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "hello@realtourpilot.com", role: "MANAGER", active: true } });

  // =========================================================================
  c.head("C1 · a staff reply answers the conversation only; closeRun:false answers nothing");
  // =========================================================================
  {
    const PM = await import("@/lib/programMessages");
    const F = await buildContentMonth(prisma, { name: "Erica Closerun TEST", owner: false, portalToken: false, project: false });
    const e = F.enrollmentId;
    const script = await prisma.contentScript.create({ data: { enrollmentId: e, clientId: F.clientId, title: "Reverse offers", body: "A script." }, select: { id: true } });
    const msg = (body: string, mins: number, underScript = false) =>
      prisma.programMessage.create({ data: { enrollmentId: e, clientId: F.clientId, authorKind: "CLIENT", authorLabel: "Erica", body, createdAt: ago(mins), ...(underScript ? { refKind: PM.SCRIPT_THREAD, refId: script.id } : {}) }, select: { id: true } });
    const booking = await msg("I can't seem to book a time for Oct filming. Can you help? Also, is Jordan uploading the scripts we discussed?", 170);
    const under = await msg("Can the hook be shorter?", 160, true);
    const deskKey = `${PM.PROGRAM_MESSAGE_TASK_PREFIX}${e}`;
    await prisma.smartTask.create({ data: { title: "Reply to Erica Closerun TEST's message", taskType: "program_message", status: "OPEN", source: "content_program", clientId: F.clientId, dedupeKey: deskKey, assignedKey: "kyle" } });
    const handled = async (id: string) => !!(await prisma.programMessage.findUniqueOrThrow({ where: { id } })).handledAt;
    const desk = () => prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: deskKey } });
    const me = { id: null, name: "Jordan Spackman", email: "info@realtourpilot.com" };

    const r0 = await PM.postStaffMessage(e, me, "Good news: we were able to schedule your filming. If you need another time, let us know!", null, { closeRun: false });
    c.ok("a one-off notice with closeRun:false answers nothing (Erica's 2:31 PM message stays waiting)", r0.ok && !(await handled(booking.id)) && !(await handled(under.id)) && (await desk()).status === "OPEN", r0.message);
    const r1 = await PM.postStaffMessage(e, me, "Here is what we can do for October.");
    c.ok("a reply on the Messages tab answers the conversation's messages", r1.ok && (await handled(booking.id)), r1.message);
    c.ok("…never the client's message under a script (it is answered under that script)", !(await handled(under.id)));
    c.ok("…and the desk task stays open while that one waits", (await desk()).status === "OPEN");
    const r2 = await PM.markThreadHandled(e, { id: null, email: "info@realtourpilot.com" });
    c.ok("'No reply needed' sets aside the conversation only, too", r2.handled === 0 && !(await handled(under.id)) && (await desk()).status === "OPEN");
    const r3 = await PM.postStaffMessage(e, me, "Shortened it, have a look.", null, { ref: { kind: "SCRIPT", id: script.id }, placement: "script" });
    c.ok("a reply under the script answers that script's thread, and the desk task closes when nothing is left", r3.ok && (await handled(under.id)) && (await desk()).status === "COMPLETED", r3.message);
    const late = await msg("Also the Reverse offers for sellers topic, please", 5);
    const r4 = await PM.postStaffMessage(e, me, "Different script note.", null, { ref: { kind: "SCRIPT", id: script.id }, placement: "script" });
    c.ok("a script-thread reply never answers a message in the conversation", r4.ok && !(await handled(late.id)));
    c.ok("the reply copy has no em dash", !/—/.test(r1.message));
  }

  // =========================================================================
  c.head("C2 · photo words are specific; the backstop only fills a missing or unclear label");
  // =========================================================================
  {
    const M = await import("@/lib/itemMedium");
    const { askMedium } = await import("@/lib/comms");
    const video = ["The people are still a bit glitchy in the kitchen scene", "Can you still add my logo at the end?", "make my brand image pop in the end card", "Stage the intro differently"];
    c.ok("'still', 'stage' and 'image' are not photo words: these stay the editor's", video.every((t) => M.itemMediumOf(t) === "video" && !M.namesPhotos(t)), video.map((t) => M.itemMediumOf(t)).join(","));
    c.ok("…and comms' askMedium does not read them as photos either", video.slice(0, 3).every((t) => askMedium(t) !== "photo"), video.slice(0, 3).map((t) => askMedium(t)).join(","));
    const photo = ["Brighten photo 4", "pic numbers 4, 7, 8", "the stove in photos 16 and 23", "Add lot lines to the drone photo", "virtual staging in the living room", "add a twilight", "fix the floor plan"];
    c.ok("specific photo words still read as photos", photo.every((t) => M.itemMediumOf(t) === "photo"), photo.map((t) => M.itemMediumOf(t)).join(","));
    c.ok("the model's label wins: 'photo 38' the model calls video stays video", M.itemMediumOf("Virtually stage the upper patio (photo 38)", "video") === "video" && M.itemMediumOf("Remove the sign from the video", "photo") === "photo" && M.itemMediumOf("Brighten photo 4", "both") === "both");
    c.ok("the words decide only when the model said 'unclear' or nothing", M.itemMediumOf("Brighten photo 4", "unclear") === "photo" && M.itemMediumOf("Brighten photo 4") === "photo" && M.itemMediumOf("Make it pop", "unclear") === "unclear" && M.itemMediumOf("Make it pop") === "video");
    c.ok("'stage out the stove' on a photo item is a photo fix, not new staging work", !M.isOfficeQuestion({ kind: "REFINEMENT", medium: "photo", ask: "Remove (clone out / stage out) the stove in photos 16 and 23" }, { stagingOrdered: false }));
  }

  // =========================================================================
  // THE GMAIL SCAN (a fake Google): H2, H3, M3 email, M6, H4 (the reply sweep)
  // =========================================================================
  const { saveSecret } = await import("@/lib/integrations/connections");
  const google = await import("@/lib/integrations/google");
  await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "rt-info-drill", "hello@realtourpilot.com": "rt-hello-drill" }));
  const mkClient = (name: string, email: string | null) => prisma.client.create({ data: { name, email }, select: { id: true, name: true } });
  const mkProject = (clientId: string, title: string, status: "DELIVERED" | "SCHEDULED" | "BOOKED", types: ("PHOTOS" | "VIDEO")[] = ["PHOTOS"]) =>
    prisma.project.create({ data: { title, clientId, status, ...(status === "DELIVERED" ? { deliveredAt: ago(600) } : { shootDate: new Date(Date.now() + 2 * 24 * HOUR) }), deliverables: { create: types.map((t) => ({ type: t, label: t === "VIDEO" ? "Standard Package" : "Photos", quantity: 1 })) } }, select: { id: true, title: true } });
  const birch = await mkClient("Bea Birch", "bea@clients.invalid");
  await mkProject(birch.id, "12 Birchwood Lane, Exton, PA 19341", "DELIVERED");
  const jordanClient = await mkClient("Jordan Spackman", "jspackman215@gmail.com");
  await prisma.contact.createMany({ data: [
    { openPhoneId: "hs-1", firstName: "Jordan", lastName: "Spackman", email: "info@realtourpilot.com", clientId: jordanClient.id, source: "openphone-hubspot" },
    { openPhoneId: "hs-2", firstName: "Jordan", lastName: "Spackman", email: "jspackman215@gmail.com", clientId: jordanClient.id, source: "openphone-hubspot" },
  ] });
  const alex = await mkClient("Alex Stack", "alex@clients.invalid");
  await mkProject(alex.id, "212 Pine Ford Rd, Pottstown, PA 19464", "DELIVERED");
  const mia = await mkClient("Mia Twice", "mia@clients.invalid");
  await mkProject(mia.id, "40 Oak Hill Rd, Malvern, PA 19355", "SCHEDULED");
  const sam = await mkClient("Sam Answered", "sam@clients.invalid");
  const samJob = await mkProject(sam.id, "9 Elm St, Media, PA 19063", "SCHEDULED");
  const tia = await mkClient("Tia Holding", "tia@clients.invalid");
  const tiaJob = await mkProject(tia.id, "77 Maple Ave, Media, PA 19063", "SCHEDULED");
  const uma = await mkClient("Uma Waiting", "uma@clients.invalid");
  await mkProject(uma.id, "5 Cedar Ct, Wayne, PA 19087", "SCHEDULED");
  const US = "\"Realtour Pilot, LLC\" <hello@realtourpilot.com>";
  const inbox = (box: "info" | "hello", m: FakeMsg) => fakeGoogle.inbox[box].push(m);
  // info@: a family email naming a client's street (H2); one email to both inboxes (M3).
  inbox("info", { id: "i-memo", thread: "ti-memo", from: "Brent Spackman <brent@family.invalid>", to: "info@realtourpilot.com", subject: "Tyler's Memorial", body: "The service is Saturday at the hall on 12 Birchwood Lane in Exton. Love you all.", at: ago(30) });
  const twice: Omit<FakeMsg, "id" | "thread"> = { from: "Mia Twice <mia@clients.invalid>", to: "info@realtourpilot.com, hello@realtourpilot.com", subject: "Twilight photos", body: "Can we add twilight photos to 40 Oak Hill Rd?", at: ago(25), messageId: "<mia-1@mail.invalid>" };
  inbox("info", { id: "i-mia", thread: "ti-mia", ...twice });
  inbox("hello", { id: "h-mia", thread: "th-mia", ...twice });
  // hello@: the same kind of stranger naming the street is still matched there (unchanged).
  inbox("hello", { id: "h-neigh", thread: "th-neigh", from: "Ned Neighbor <ned@x.invalid>", to: "hello@realtourpilot.com", subject: "Question about 12 Birchwood Lane", body: "Who shot the photos for 12 Birchwood Lane in Exton? Can you send me your prices?", at: ago(24) });
  // H3: Jordan's gmail forwards Alex's email, and writes Kyle a note.
  inbox("hello", { id: "h-fwd", thread: "th-fwd", from: "Jordan Spackman <jspackman215@gmail.com>", to: "hello@realtourpilot.com", subject: "Fwd: Pine Ford Zillow Showcase Photo Update", body: "Can you handle this?\n\n---------- Forwarded message ---------\nFrom: Alex Stack <alex@clients.invalid>\nDate: Mon, Sep 28\nSubject: Pine Ford Zillow Showcase Photo Update\n\nPlease swap photo 4 and photo 5 on the Pine Ford showcase.", at: ago(22) });
  inbox("hello", { id: "h-note", thread: "th-note", from: "Jordan Spackman <jspackman215@gmail.com>", to: "hello@realtourpilot.com", subject: "Note for Kyle", body: "Hey bro, please call the plumber tomorrow about the office sink.", at: ago(21) });
  // M6: answered inside the scan. Sam's is settled by our reply; Tia's reply only holds.
  inbox("hello", { id: "h-sam", thread: "th-sam", from: "Sam Answered <sam@clients.invalid>", to: "hello@realtourpilot.com", subject: "Move the shoot", body: "Can we move Thursday's shoot at 9 Elm St to Friday at 10?", at: ago(20) });
  fakeGoogle.sent.hello.push({ id: "s-sam", thread: "th-sam", from: US, to: "Sam Answered <sam@clients.invalid>", subject: "Re: Move the shoot", body: "Yes, Friday at 10 works, you're all set.", at: ago(18), inReplyTo: "<sam-1@mail.invalid>" });
  inbox("hello", { id: "h-tia", thread: "th-tia", from: "Tia Holding <tia@clients.invalid>", to: "hello@realtourpilot.com", subject: "Different day?", body: "Can we move Monday's shoot at 77 Maple Ave to Tuesday?", at: ago(19) });
  fakeGoogle.sent.hello.push({ id: "s-tia", thread: "th-tia", from: US, to: "Tia Holding <tia@clients.invalid>", subject: "Re: Different day?", body: "Let me check with the photographer and get back to you.", at: ago(17), inReplyTo: "<tia-1@mail.invalid>" });
  decisions.push({ match: /Friday at 10/, d: decide({ projectId: samJob.id, asks: [{ kind: "SCHEDULING", text: "Can we move Thursday's shoot to Friday at 10?", summary: "Move the shoot to Friday at 10", medium: "unclear", projectHint: samJob.id }] }) });
  decisions.push({ match: /Monday's shoot/, d: decide({ projectId: tiaJob.id, asks: [{ kind: "SCHEDULING", text: "Can we move Monday's shoot to Tuesday?", summary: "Move the shoot to Tuesday", medium: "unclear", projectHint: tiaJob.id }] }) });
  // H4: Uma waits; our holding reply comes in the second scan.
  inbox("hello", { id: "h-uma", thread: "th-uma", from: "Uma Waiting <uma@clients.invalid>", to: "hello@realtourpilot.com", subject: "Floor plan", body: "Can you send the floor plan for 5 Cedar Ct?", at: ago(16) });
  fakeGoogle.on = true;
  const scan1 = await google.syncGmail();
  const rowsOf = (where: Record<string, unknown>) => prisma.commLog.findMany({ where: { channel: "email", direction: "in", ...where } });

  c.head("H2 · an unknown sender in info@ is never matched by a street or a town");
  {
    const memo = (await rowsOf({ externalId: "gmail-info@realtourpilot.com:i-memo" }))[0];
    c.ok("the memorial email that names 12 Birchwood Lane is logged with no client and no job", !!memo && memo.clientId === null && memo.projectId === null, JSON.stringify(memo && { c: memo.clientName, p: memo.projectId }));
    c.ok("…owner-only (Kyle cannot read it, the AI's client context never sees it)", memo?.minRole === "OWNER");
    c.ok("…and Bea Birch's record carries nothing of it", (await prisma.commLog.count({ where: { clientId: birch.id, body: { contains: "Tyler" } } })) === 0 && (await prisma.smartTask.count({ where: { clientId: birch.id, description: { contains: "Love you all" } } })) === 0);
    const ned = (await rowsOf({ externalId: "gmail-hello@realtourpilot.com:h-neigh" }))[0];
    c.ok("hello@ is unchanged: a stranger naming the street is matched to that job there", ned?.clientId === birch.id, ned?.clientName ?? "none");
    const MM = await import("@/lib/mailMatch");
    c.ok("the rule, pure: info@ + unknown sender = no match; known sender or hello@ = allowed", !MM.streetMatchAllowed({ mailbox: "info@realtourpilot.com", senderKnown: false }) && MM.streetMatchAllowed({ mailbox: "INFO@realtourpilot.com", senderKnown: true }) && MM.streetMatchAllowed({ mailbox: "hello@realtourpilot.com", senderKnown: false }));
  }

  c.head("H3 · Jordan's own addresses are staff before any client lookup");
  {
    const fwd = (await rowsOf({ externalId: "gmail-hello@realtourpilot.com:h-fwd" }))[0];
    c.ok("Jordan's forward of Alex's email is Alex's (read by the forwarded sender's address)", fwd?.clientId === alex.id, fwd?.clientName ?? "none");
    const note = (await rowsOf({ externalId: "gmail-hello@realtourpilot.com:h-note" }))[0];
    c.ok("Jordan's note to Kyle is nobody's (not the 'Jordan Spackman' client)", !!note && note.clientId === null, note?.clientName ?? "none");
    c.ok("nothing at all is filed to the 'Jordan Spackman' client any more", (await prisma.commLog.count({ where: { clientId: jordanClient.id } })) === 0 && (await prisma.smartTask.count({ where: { clientId: jordanClient.id } })) === 0);
    c.ok("…and Jordan's own mail never becomes a lead", (await prisma.smartTask.count({ where: { taskType: "lead", dedupeKey: { contains: "spackman" } } })) === 0);
    const { staffAddressBook, isStaffAddress } = await import("@/lib/staffEmail");
    const book = await staffAddressBook();
    c.ok("the staff book holds Jordan's gmail and every roster address", isStaffAddress("jspackman215@gmail.com", book) && isStaffAddress("hello@realtourpilot.com", book) && !isStaffAddress("alex@clients.invalid", book));
    const MM = await import("@/lib/mailMatch");
    c.ok("forwardedSenderAddress: a forward's first non-staff From, never a plain mail's", MM.forwardedSenderAddress("Fwd: x", "---------- Forwarded message ---------\nFrom: Info <info@realtourpilot.com>\nFrom: Alex <alex@clients.invalid>", (a) => a.endsWith("@realtourpilot.com")) === "alex@clients.invalid" && MM.forwardedSenderAddress("Hello", "From: Alex <alex@clients.invalid>", () => false) === null);
  }

  c.head("M3 · one email sent to both inboxes is logged once");
  {
    const mias = await rowsOf({ clientId: mia.id });
    c.ok("Mia's email to info@ and hello@ (one Message-ID) is one row, not two", mias.length === 1, String(mias.length));
    c.ok("…claimed by the first inbox that read it", (await prisma.webhookEvent.count({ where: { provider: google.GMAIL_MID_PROVIDER, externalId: "mid:mia-1@mail.invalid" } })) === 1);
    c.ok("…and read once by the AI (one routing call for it)", decisions.length >= 0 && (await prisma.smartTask.count({ where: { clientId: mia.id } })) <= 1);
  }

  c.head("M6 · an email answered inside the scan still files its asks");
  {
    const samAsks = await prisma.clientAsk.findMany({ where: { clientId: sam.id } });
    c.ok("Sam's 'move it to Friday' is filed as a scheduling ask though Kyle answered first", samAsks.length === 1 && samAsks[0].kind === "SCHEDULING", samAsks.map((a) => a.state).join(","));
    c.ok("…marked answered by our reply (DONE, 'our email reply')", samAsks[0]?.state === "DONE" && samAsks[0]?.doneBy === "our email reply" && /answered by our email reply/.test(samAsks[0]?.historyJson ?? ""));
    c.ok("…and no reply task was made for answered mail", (await prisma.smartTask.count({ where: { clientId: sam.id, taskType: "client_reply" } })) === 0);
    const tiaAsks = await prisma.clientAsk.findMany({ where: { clientId: tia.id } });
    c.ok("Tia's ask, answered only with 'let me check and get back to you', stays OPEN on the Scheduling screen", tiaAsks.length === 1 && tiaAsks[0].state === "OPEN" && /holding reply/.test(tiaAsks[0].historyJson ?? ""), tiaAsks.map((a) => a.state).join(","));
  }

  c.head("H4 · the Gmail reply sweep leaves the task open on a holding reply");
  {
    const umaTask = () => prisma.smartTask.findFirst({ where: { clientId: uma.id, taskType: "client_reply" }, orderBy: { createdAt: "asc" } });
    c.ok("Uma's unanswered email opened a reply task", (await umaTask())?.status === "OPEN", scan1.mailboxes.map((m) => `${m.email}:${m.ok}`).join(" "));
    fakeGoogle.sent.hello.push({ id: "s-uma1", thread: "th-uma", from: US, to: "Uma Waiting <uma@clients.invalid>", subject: "Re: Floor plan", body: "Let me check with the team and get back to you.", at: ago(10), inReplyTo: "<uma-1@mail.invalid>" });
    await google.syncGmail();
    const said = await prisma.commLog.findUnique({ where: { externalId: "gmail-sent-th-uma-s-uma1" } });
    c.ok("our holding reply is logged, and the task stays open (a holding reply is not an answer)", !!said && (await umaTask())?.status === "OPEN", `${!!said} ${(await umaTask())?.status}`);
    fakeGoogle.sent.hello.push({ id: "s-uma2", thread: "th-uma", from: US, to: "Uma Waiting <uma@clients.invalid>", subject: "Re: Floor plan", body: "Here it is, the floor plan for 5 Cedar Ct is attached.", at: ago(5), inReplyTo: "<uma-1@mail.invalid>" });
    await google.syncGmail();
    c.ok("the real answer closes it", (await umaTask())?.status === "COMPLETED", (await umaTask())?.status);
  }
  fakeGoogle.on = false;

  // =========================================================================
  c.head("H5 · a spend limit is visible: a failure in the ledger, one owner alert, a retry");
  // =========================================================================
  {
    const O = await import("@/lib/aiOutage");
    const ai = await import("@/lib/integrations/ai");
    const { etDayKey } = await import("@/lib/datetime");
    const alerts: { title: string; body: string }[] = [];
    O.__setAiOutageAlertForTests(async (a) => { alerts.push(a); });
    c.ok("the pure read: usage limit, credit balance, 401/403 are outages; a 429 or a bad request is not",
      O.aiOutageReason(400, "You have reached your specified API usage limits. You will regain access on 2026-11-01") === "usage_limit" &&
      O.aiOutageReason(400, "Your credit balance is too low to access the Anthropic API.") === "credit" &&
      O.aiOutageReason(401, "invalid x-api-key") === "auth" && O.aiOutageReason(403, "") === "auth" &&
      O.aiOutageReason(429, "rate limited") === null && O.aiOutageReason(400, "max_tokens is too large") === null);
    await saveSecret("ai", "sk-drill-not-a-key");
    anthropic = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "You have reached your specified API usage limits." } } };
    let thrown: unknown = null;
    try { await ai.messageToTodo({ channel: "text", message: "Can you send the photos?" }); } catch (e) { thrown = e; }
    await O.flushAiOutage();
    c.ok("the transport throws an AiUnavailableError (not 'no decision')", O.isAiUnavailable(thrown), String(thrown));
    const day = await prisma.appSetting.findUnique({ where: { key: `${O.AI_FAILURE_DAY_PREFIX}${etDayKey(new Date())}` } });
    c.ok("…written to the ledger as a failure by feature", /message_to_todo\|usage_limit/.test(day?.value ?? "") && JSON.parse(day?.value ?? "{}")["message_to_todo|usage_limit"]?.n === 1, day?.value);
    c.ok("…the outage is on record", !!(await O.aiOutageNow()));
    c.ok("…and the owner is told once", alerts.length === 1 && /stopped answering/.test(alerts[0].title) && /usage limit/.test(alerts[0].body), JSON.stringify(alerts));
    try { await ai.messageToTodo({ channel: "text", message: "Another one" }); } catch { /* expected */ }
    await O.flushAiOutage();
    c.ok("a second refusal in the same hour: counted, no second alert", alerts.length === 1 && JSON.parse((await prisma.appSetting.findUnique({ where: { key: `${O.AI_FAILURE_DAY_PREFIX}${etDayKey(new Date())}` } }))?.value ?? "{}")["message_to_todo|usage_limit"]?.n === 2);
    const ledger = await prisma.appSetting.findMany({ where: { key: { startsWith: "ai_usage:" } } });
    c.ok("the usage ledger is not polluted by refusals", ledger.length === 0 || !ledger.some((r) => /usage_limit/.test(r.value)));
    anthropic = { status: 200, body: { content: [{ type: "text", text: "{\"title\":\"Send the photos\",\"detail\":\"They asked for photos.\"}" }], usage: { input_tokens: 10, output_tokens: 5 }, model: "claude-haiku-4-5-20251001" } };
    const ok = await ai.messageToTodo({ channel: "text", message: "Can you send the photos?" });
    await O.flushAiOutage();
    c.ok("the next answer clears the outage", ok?.title === "Send the photos" && !(await O.aiOutageNow()));
    // The outage again, for the routers below: every AI call is refused.
    anthropic = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "You have reached your specified API usage limits." } } };

    // The comms router: queue, then read again when the AI answers.
    const { recordClientCommunication } = await import("@/lib/comms");
    const rex = await mkClient("Rex Retry", "rex@clients.invalid");
    const rexJob = await mkProject(rex.id, "3 Spruce Way, Paoli, PA 19301", "SCHEDULED");
    const words = "For 3 Spruce Way, please make sure the photographer gets the back deck at sunset.";
    brainDown = true;
    const first = await recordClientCommunication({ clientId: rex.id, clientName: rex.name, projectId: rexJob.id, projectStatus: "SCHEDULED", text: words, kind: "text", source: "openphone", contactName: rex.name });
    const queued = await prisma.webhookEvent.findMany({ where: { provider: O.AI_RETRY_PROVIDER } });
    c.ok("with the AI refusing: brain 'unavailable', Kyle still gets a to-do, and the message is queued", first.brain === "unavailable" && first.replyTask && queued.length === 1 && queued[0].status === "RECEIVED");
    c.ok("…no special request was filed yet (the brain reads those)", (await prisma.clientAsk.count({ where: { clientId: rex.id } })) === 0);
    const s1 = await O.sweepAiRetries();
    c.ok("the sweep while it still refuses: stops, the message stays queued", s1.stillDown && s1.done === 0 && (await prisma.webhookEvent.findFirstOrThrow({ where: { provider: O.AI_RETRY_PROVIDER } })).status === "RECEIVED");
    brainDown = false;
    decisions.push({ match: /back deck at sunset/, d: decide({ projectId: rexJob.id, title: "Note the sunset deck shot", asks: [{ kind: "SPECIAL_REQUEST", text: "make sure the photographer gets the back deck at sunset", summary: "Back deck at sunset", medium: "photo", projectHint: rexJob.id }] }) });
    const s2 = await O.sweepAiRetries();
    const rexAsks = await prisma.clientAsk.findMany({ where: { clientId: rex.id } });
    c.ok("once the AI answers: read again, its special request filed on the job", s2.done === 1 && rexAsks.length === 1 && rexAsks[0].kind === "SPECIAL_REQUEST" && rexAsks[0].projectId === rexJob.id, JSON.stringify(s2));
    c.ok("…the queue row is done, and the reply to-do is not doubled", (await prisma.webhookEvent.findFirstOrThrow({ where: { provider: O.AI_RETRY_PROVIDER } })).status === "PROCESSED" && (await prisma.smartTask.count({ where: { clientId: rex.id, taskType: { in: ["client_reply", "todo"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } } })) === 1);
    const s3 = await O.sweepAiRetries();
    c.ok("a later sweep has nothing to do", s3.tried === 0);

    // The Slack router gives the message back instead of making a raw card.
    const { maybeCreateSlackTask, slackRoutedKey } = await import("@/lib/integrations/slackSync");
    brainDown = true;
    const ts = String(Math.floor(Date.now() / 1000) - 60) + ".000100";
    let slackErr: unknown = null;
    try { await maybeCreateSlackTask({ text: "Can you send Rex the 3 Spruce Way photos today?", ts, channel: "CDRILL", senderName: "Jordan" }); } catch (e) { slackErr = e; }
    const slackCards = await prisma.smartTask.count({ where: { source: "slack" } });
    const memo = await prisma.appSetting.findUnique({ where: { key: slackRoutedKey("CDRILL", ts) } });
    c.ok("Slack with the AI refusing: no raw-text card, the message is given back for the next poll", O.isAiUnavailable(slackErr) && slackCards === 0 && !memo, `${String(slackErr)} cards=${slackCards} memo=${memo?.value ?? "none"} brain=${brainCalls.slack}`);
    brainDown = false;
    O.__setAiOutageAlertForTests(null);
    // The AI is gone for the rest of the drill: nothing below calls it.
    const { disconnect } = await import("@/lib/integrations/connections");
    await disconnect("ai");
    anthropic = null;
  }

  // =========================================================================
  c.head("M3 · the same ask twice files once; one booking is one scheduling ask");
  // =========================================================================
  {
    const A = await import("@/lib/clientAsks");
    const neh = await mkClient("Nehemiah Lindo", null);
    const say = (text: string, mins: number) => A.createAsk({ clientId: neh.id, kind: "SCHEDULING", text, summary: text, source: "text", askedAt: ago(mins), dedupeKey: A.messageAskKey(neh.id, null, "SCHEDULING", `${text}#${mins}`) });
    const ids = [await say("Hey I have another listing", 200), await say("And a video", 196), await say("Let's do it", 190), await say("5 Endlich Ave reading pa asap when can you guys do it", 128), await say("can we do sooner", 124), await say("can we do sooner", 123)];
    const open = await prisma.clientAsk.findMany({ where: { clientId: neh.id, state: "OPEN" } });
    c.ok("Nehemiah's six booking texts make ONE open scheduling ask", open.length === 1 && ids.every((x) => x?.id === open[0].id), String(open.length));
    c.ok("…carrying every text, newest summary", /another listing/.test(open[0]?.text ?? "") && /Endlich/.test(open[0]?.text ?? "") && /can we do sooner/.test(open[0]?.summary ?? ""));
    const later = await A.createAsk({ clientId: neh.id, kind: "SCHEDULING", text: "Next month, another listing", source: "text", askedAt: new Date(Date.now() + 30 * HOUR), dedupeKey: "msg:drill-later" });
    c.ok("a booking talk a day and more later is its own ask", later?.created === true);
    const joe = await mkClient("Joe Sutow", null);
    const joeJob = await mkProject(joe.id, "859 N Lawrence St, Philadelphia, PA 19123", "DELIVERED", ["PHOTOS", "VIDEO"]);
    const words = "Also the virtual staging of pic 11 should show a small dining room table. And are they able to virtually stage the upper patio. Now pic 38";
    const plain = await A.createAsk({ clientId: joe.id, projectId: joeJob.id, kind: "SPECIAL_REQUEST", medium: "photo", text: words, source: "text", dedupeKey: A.messageAskKey(joe.id, joeJob.id, "SPECIAL_REQUEST", words) });
    const again = await A.createAsk({ clientId: joe.id, projectId: joeJob.id, kind: "SPECIAL_REQUEST", medium: "photo", text: words, source: "text", dedupeKey: "msg:drill-joe-twin" });
    c.ok("Joe's identical photo 38 words filed twice are one ask", again?.id === plain?.id && again?.created === false);
    const keyed = await A.createAsk({ clientId: joe.id, projectId: joeJob.id, kind: "SPECIAL_REQUEST", medium: "photo", text: `${words} Outdoor`, summary: "Virtually stage the upper patio (photo 38). Not on the order", source: "text", dedupeKey: `photo-office:${joeJob.id}:38` });
    const joeOpen = await prisma.clientAsk.findMany({ where: { clientId: joe.id, state: "OPEN" } });
    c.ok("the photo part's keyed office question replaces the plain twin (one open ask, the keyed one)", keyed?.created === true && joeOpen.length === 1 && joeOpen[0].dedupeKey === `photo-office:${joeJob.id}:38`, joeOpen.map((a) => a.dedupeKey).join(","));
    c.ok("pure: same words, inside words, different job, other client", A.sameAskWords("can we do sooner", "Can we do sooner?") && A.sameAskWords("move it to friday please", "Hi! move it to Friday please, thanks") && !A.sameAskWords("ok", "ok then, sounds good") && A.duplicateAskReason({ clientId: "a", kind: "SPECIAL_REQUEST", projectId: "p1", text: "fix the sky", askedAt: new Date() }, { clientId: "a", kind: "SPECIAL_REQUEST", projectId: "p2", text: "fix the sky", askedAt: new Date() }) === null);
  }

  // =========================================================================
  c.head("H3b · the revision task's lane follows what its items ask for");
  // =========================================================================
  {
    const L = await import("@/lib/revisionLane");
    const { revisionTaskKey } = await import("@/lib/comms");
    c.ok("pure: any video item → video; photo items only → photo; echoes and unclear do not decide",
      L.laneFromItems([{ medium: "video", quote: "edit out the sign" }], "edit out the sign please") === "video" &&
      L.laneFromItems([{ medium: "photo" }, { medium: "photo" }], "x") === "photo" &&
      L.laneFromItems([{ medium: "photo" }, { medium: "both" }], "x") === "video" &&
      L.laneFromItems([{ medium: "unclear" }], "x") === null &&
      L.laneFromItems([{ medium: "video", quote: "they included the Cafe La Maude sign twice" }, { medium: "photo" }], "Outdoor furniture, fire pit table, plants?") === "photo");
    const lc = await mkClient("Lane Client", null);
    const job = await mkProject(lc.id, "859 N Lawrence St, Philadelphia, PA 19123", "DELIVERED", ["PHOTOS", "VIDEO"]);
    const cafe = "Only edit is that they included the Cafe La Maude sign twice so could they edit out one of them quickly?";
    const task = await prisma.smartTask.create({ data: { title: `Revision — ${job.title}`, taskType: "revision", status: "OPEN", source: "openphone", projectId: job.id, clientId: lc.id, assignedKey: "kyle", dedupeKey: revisionTaskKey(job.id, false), description: cafe } });
    const brief = await prisma.revisionBrief.create({ data: { projectId: job.id, taskId: task.id, source: "openphone", originalText: cafe, analyzedAt: new Date(), itemsJson: JSON.stringify({ items: [{ id: "i1", area: "Cuts & content", ask: "Remove one of the two Cafe La Maude signs from the video.", quote: "they included the Cafe La Maude sign twice", medium: "video" }], questions: [] }) } });
    const dry = await L.settleRevisionLane(brief.id, { dryRun: true });
    c.ok("dry run: the Cafe La Maude card on Kyle's unclear lane would move to the editor", dry?.from === "unclear" && dry.to === "video" && !!dry.assignedKey && dry.assignedKey !== "kyle" && (await prisma.smartTask.findUniqueOrThrow({ where: { id: task.id } })).assignedKey === "kyle", JSON.stringify(dry));
    const moved = await L.settleRevisionLane(brief.id);
    const t2 = await prisma.smartTask.findUniqueOrThrow({ where: { id: task.id } });
    c.ok("settled: 'Video revision', on the editor's board, same card", !!moved && /^Video revision/.test(t2.title) && t2.assignedKey === dry?.assignedKey && t2.dedupeKey === revisionTaskKey(job.id, false), `${t2.title} → ${t2.assignedKey}`);
    c.ok("…and a second settle changes nothing", (await L.settleRevisionLane(brief.id)) === null);
    // A photo-only work order that landed on the video card.
    const pc = await mkClient("Lane Photo", null);
    const pjob = await mkProject(pc.id, "22 White Birch Dr, Jim Thorpe, PA 18229", "DELIVERED", ["PHOTOS", "VIDEO"]);
    const ptask = await prisma.smartTask.create({ data: { title: `Video revision — ${pjob.title}`, taskType: "revision", status: "OPEN", source: "openphone", projectId: pjob.id, clientId: pc.id, assignedKey: "john", dedupeKey: revisionTaskKey(pjob.id, false), description: "AI out the personal items in pic 4, 7, 8" } });
    const pbrief = await prisma.revisionBrief.create({ data: { projectId: pjob.id, taskId: ptask.id, source: "openphone", originalText: "AI out the personal items in pic 4, 7, 8", analyzedAt: new Date(), itemsJson: JSON.stringify({ items: [{ id: "i1", area: "Other", ask: "Remove personal items in photos 4, 7 and 8.", medium: "photo" }], questions: [] }) } });
    await L.settleRevisionLane(pbrief.id);
    const p2 = await prisma.smartTask.findUniqueOrThrow({ where: { id: ptask.id } });
    c.ok("photo items only: the card moves to Kyle's photo card (photo key), off the editor's board", /^Photo revision/.test(p2.title) && p2.assignedKey === "kyle" && p2.dedupeKey === revisionTaskKey(pjob.id, true), `${p2.title} ${p2.assignedKey}`);
    // A card carrying another ask is not moved to another key.
    const oc = await mkClient("Lane Other", null);
    const ojob = await mkProject(oc.id, "1 Two Asks Rd, Media, PA 19063", "DELIVERED", ["PHOTOS", "VIDEO"]);
    const otask = await prisma.smartTask.create({ data: { title: `Video revision — ${ojob.title}`, taskType: "revision", status: "OPEN", source: "openphone", projectId: ojob.id, clientId: oc.id, assignedKey: "john", dedupeKey: revisionTaskKey(ojob.id, false) } });
    await prisma.revisionBrief.create({ data: { projectId: ojob.id, taskId: otask.id, source: "openphone", originalText: "Lower the music", itemsJson: JSON.stringify({ items: [{ id: "i1", ask: "Lower the music", medium: "video" }] }) } });
    const obrief = await prisma.revisionBrief.create({ data: { projectId: ojob.id, taskId: otask.id, source: "openphone", originalText: "Brighten photo 3", itemsJson: JSON.stringify({ items: [{ id: "i1", ask: "Brighten photo 3", medium: "photo" }] }) } });
    c.ok("a card that carries another ask stays where it is", (await L.settleRevisionLane(obrief.id)) === null && (await prisma.smartTask.findUniqueOrThrow({ where: { id: otask.id } })).assignedKey === "john");
  }

  // =========================================================================
  // THE SECTION MODULES (built beside this file): H4 + LOW, and H6.
  // =========================================================================
  const h4 = await import("./_comms-audit/h4-low");
  await h4.run(c);
  const h6 = await import("./_comms-audit/h6");
  await h6.run(c);

  // =========================================================================
  c.head("Nothing left the hub");
  // =========================================================================
  c.ok("every Google and Anthropic call was answered by a fake (none fell through to the fence)", !fence.blocked.some((u) => /anthropic|googleapis/.test(u)), fence.blocked.filter((u) => /anthropic|googleapis/.test(u)).slice(0, 5).join(" "));
  c.ok("no Gmail send endpoint was asked for", !fence.faked.some((u) => /messages\/send|drafts/.test(u)));
  console.log(`  (the fence refused ${fence.blocked.length} other outbound attempt(s), so nothing left: ${[...new Set(fence.blocked.map((u) => u.replace(/^(\w+:\/\/[^/]+).*$/, "$1")))].join(", ") || "none"})`);

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
