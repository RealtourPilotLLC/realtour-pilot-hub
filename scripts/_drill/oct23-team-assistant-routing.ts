// ---------------------------------------------------------------------------
// DRILL: A TEAM ASSISTANT'S MESSAGES GO TO THE AGENT WHOSE JOB THEY NAME
// (Oct 23 2026, lib/teamRouting).
//
//   DRILL_PORT=7141 node scripts/_drill/run-all.cjs scripts/_drill/oct23-team-assistant-routing.ts
//
// Olivia Vecere (Gary Mercer Team) folds onto Mike Flatley in Aryeo, but her
// mail is about Sharra Mercer's and Joe Sutow's jobs too. Through the SHIPPED
// receivers (the Gmail scan, the OpenPhone receiver, the ask filing):
//   1  the rule, pure: company domains, the candidate agents, a signature's
//      office address names nobody, a solo client has no team
//   2  Gmail: her email naming Sharra's job lands on Sharra's job; Joe's
//      (his backup email is on the team domain) on Joe's; a listing link in
//      the quoted thread counts; naming Mike's own job stays with Mike; naming
//      no job goes to Mike; an office address in her signature does not count
//   3  Gmail: our reply to her stays in her conversation (Sharra's)
//   4  Gmail: an unknown sender (info@) is still never matched by a street, a
//      stranger on the team's domain included; a solo client is unchanged
//   5  asks: an ask in her email naming Mike's job is filed on Mike's job
//   6  OpenPhone texts: the same four cases; our reply text follows her
//      conversation; an unknown number is never matched
//   7  OpenPhone call notes: a call naming Joe's job lands on Joe's job
//
// ISOLATION: PGlite via the shared harness; the Smart Brain stubbed at its
// two functions; Google answered by a fake at the fence; nothing else leaves.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7141);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

// ---- the Smart Brain, stubbed: no decision unless a section sets one ----
type Ask = { kind: "SPECIAL_REQUEST" | "SCHEDULING"; text: string; summary: string; medium: "video" | "photo" | "both" | "unclear"; projectHint: string | null };
type Decision = { actionable: boolean; projectId: string | null; title: string; detail: string; priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW"; mergeIntoTaskId: string | null; isRevisionRequest: boolean; flags: string[]; reason: string; taskType: "client_reply" | "todo"; asks?: Ask[] };
const decisions: { match: RegExp; d: Decision }[] = [];
const decide = (p: Partial<Decision>): Decision => ({ actionable: true, projectId: null, title: "Reply to the client", detail: "x", priority: "HIGH", mergeIntoTaskId: null, isRevisionRequest: false, flags: [], reason: "drill", taskType: "client_reply", asks: [], ...p });
interceptModule(
  (r) => r === "@/lib/brain" || /[\\/]src[\\/]lib[\\/]brain(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "routeCommTask") return async (input: { message: string }) => decisions.find((x) => x.match.test(input.message))?.d ?? null;
      if (k === "routeSlackTask") return async () => null;
      return t[k];
    },
  }),
);
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => null : t[k]; } }),
);

// ---- a fake Google (the real syncGmail), as oct22-comms-audit-fixes.ts ----
type FakeMsg = { id: string; thread: string; from: string; to: string; subject: string; body: string; at: Date; inReplyTo?: string; messageId?: string };
const fakeGoogle = { inbox: { info: [] as FakeMsg[], hello: [] as FakeMsg[] }, sent: { info: [] as FakeMsg[], hello: [] as FakeMsg[] } };
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
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const ago = (m: number) => new Date(Date.now() - m * MIN);
    await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "info@realtourpilot.com", role: "PHOTOGRAPHER", active: true } });
    await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "hello@realtourpilot.com", role: "MANAGER", active: true, phone: "(215) 555-0199" } });

    // ---- the Gary Mercer Team, as live (team domain gmtdrill.com) ----
    const mk = (data: { name: string; email: string | null; backupEmail?: string; phone?: string; aryeoTeamId?: string; parentClientId?: string }) => prisma.client.create({ data, select: { id: true, name: true } });
    const mike = await mk({ name: "Mike Flatley", email: "mike@gmtdrill.com", phone: "(610) 555-0171", aryeoTeamId: "team-mike" });
    const sharra = await mk({ name: "Sharra Mercer", email: "smercer@gmtdrill.com", phone: "(610) 555-0172", aryeoTeamId: "team-ws" });
    const joe = await mk({ name: "Joseph Sutow", email: "jcsutow@gmail.com", backupEmail: "jsutow@gmtdrill.com", phone: "(610) 555-0173", aryeoTeamId: "team-ws" });
    const olivia = await mk({ name: "Olivia Vecere", email: "olivia@gmtdrill.com", phone: "(484) 555-5714", aryeoTeamId: "team-mike", parentClientId: mike.id });
    const solo = await mk({ name: "Sam Solo", email: "sam.solo@gmail.com", phone: "(610) 555-0180" });
    const job = (clientId: string, title: string, status: "DELIVERED" | "EDITING" | "REVIEW" | "SCHEDULED", daysAgo: number, listing?: string) =>
      prisma.project.create({ data: { title, addressLine: title.split(",")[0], clientId, status, orderedAt: new Date(Date.now() - daysAgo * DAY), aryeoListingId: listing ?? null, ...(status === "DELIVERED" ? { deliveredAt: new Date(Date.now() - (daysAgo - 3) * DAY) } : {}), ...(status === "SCHEDULED" ? { shootDate: new Date(Date.now() + 2 * DAY) } : {}), deliverables: { create: [{ type: "VIDEO", label: "Listing Reel", quantity: 1 }] } }, select: { id: true, title: true } });
    const lakeview = await job(mike.id, "913 Lakeview Ct, King of Prussia, PA 19406", "EDITING", 20);
    const quail = await job(mike.id, "2 Quail Run Ln, Glenmoore, PA 19343", "SCHEDULED", 30);
    const LISTING = "019ffb80-5740-73ea-8cd8-e03b6b5847b7";
    const carolannes = await job(sharra.id, "1337 Carolannes Way, West Chester, PA 19382", "DELIVERED", 60, LISTING);
    const oakland = await job(sharra.id, "34 Oakland Rd, West Chester, PA 19382", "REVIEW", 9);
    await job(sharra.id, "893 S Matlack St, West Chester, PA 19382", "DELIVERED", 90);
    const hickory = await job(joe.id, "2402 Hickory Hill Rd, Chadds Ford, PA 19317", "EDITING", 12);
    await job(joe.id, "893 S Matlack St Gary Mercer Team Office, West Chester, PA 19382", "REVIEW", 15);
    const soloJob = await job(solo.id, "77 Maple Ave, Media, PA 19063", "DELIVERED", 40);
    const SIG = "\n\nOlivia Vecere\nExecutive Assistant to Sharra Mercer, Gary Mercer Team\nOffice: 893 S. Matlack St, West Chester, PA 19382\nwww.GaryMercerTeam.com";

    // =========================================================================
    c.head("1 · the rule, pure");
    // =========================================================================
    const T = await import("@/lib/teamRouting");
    {
      c.ok("a company domain is a company's; gmail, outlook, icloud and ours are not", T.companyDomain("Olivia@GaryMercerTeam.com") === "garymercerteam.com" && T.companyDomain("x@gmail.com") === null && T.companyDomain("x@outlook.com") === null && T.companyDomain("x@icloud.com") === null && T.companyDomain("kyle@realtourpilot.com") === null);
      const dir = await T.loadTeamDirectory();
      const cand = T.teamCandidates(dir, olivia.id);
      c.ok("Olivia's candidates: Mike (her parent, the default), Sharra and Joe (the team domain; Joe by his backup email)", !!cand && cand.defaultId === mike.id && cand.roots.has(sharra.id) && cand.roots.has(joe.id) && !cand.roots.has(solo.id), JSON.stringify(cand && [...cand.roots].map((r) => dir.clients.get(r)?.name)));
      c.ok("a solo client has no team: unchanged routing", T.teamCandidates(dir, solo.id) === null && T.decideTeamRoute(dir, solo.id, { subject: "1337 Carolannes Way" }).action === "none");
      const office = T.decideTeamRoute(dir, olivia.id, { subject: "Harrison's battery", body: `Harrison left a charger behind.${SIG}` });
      c.ok("the office address in her signature (a job of two clients) names nobody: stays with Mike", office.action === "stay" && !("job" in office && office.job), JSON.stringify(office));
      const both = T.decideTeamRoute(dir, olivia.id, { subject: "2 Quail Run and 34 Oakland Rd" });
      c.ok("the parent's own job named in the subject keeps it with the parent, whatever else it names", both.action === "stay");
      const two = T.decideTeamRoute(dir, olivia.id, { body: "Can we do 34 Oakland Rd and 1337 Carolannes Way this week?" });
      c.ok("two of one agent's jobs named: the one in flight (34 Oakland Rd, in review)", two.action === "move" && two.route.project.id === oakland.id, JSON.stringify(two.action === "move" && two.route.project.title));
    }

    // =========================================================================
    // THE GMAIL SCAN (a fake Google)
    // =========================================================================
    const { saveSecret } = await import("@/lib/integrations/connections");
    const google = await import("@/lib/integrations/google");
    await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "rt-info-drill", "hello@realtourpilot.com": "rt-hello-drill" }));
    const OLIVIA = "Olivia Vecere <olivia@gmtdrill.com>";
    const US = "\"Realtour Pilot, LLC\" <hello@realtourpilot.com>";
    const inbox = (box: "info" | "hello", m: FakeMsg) => fakeGoogle.inbox[box].push(m);
    inbox("info", { id: "g-sussex", thread: "t-sussex", from: OLIVIA, to: "info@realtourpilot.com", subject: "New construction videos for Sussex", body: `Sharra asked me to share a final change request for 1337 Carolannes Way: the people are glitchy in the kitchen clip.${SIG}`, at: ago(60) });
    inbox("info", { id: "g-joe", thread: "t-joe", from: OLIVIA, to: "info@realtourpilot.com", subject: "Showcase release", body: `Please release the showcase for 2402 Hickory Hill Rd when it is ready.${SIG}`, at: ago(59) });
    inbox("info", { id: "g-thread", thread: "t-thread", from: OLIVIA, to: "info@realtourpilot.com", subject: "Re: Sussex Community Videos Feedback", body: `Can we have an extension into next week for the revisions?${SIG}\n\nOn Mon, Aug 31, 2026 at 12:09 PM Realtour Pilot, LLC <hello@realtourpilot.com> wrote:\n> Hi Sharra and Olivia,\n> You can view them here!\n> https://media.realtourpilot.com/listings/${LISTING}/download-center\n`, at: ago(58) });
    inbox("info", { id: "g-quail", thread: "t-quail", from: OLIVIA, to: "info@realtourpilot.com", subject: "2 Quail Run - Photos", body: `Mike would like the twilight photos swapped.${SIG}`, at: ago(57) });
    inbox("info", { id: "g-none", thread: "t-none", from: OLIVIA, to: "info@realtourpilot.com", subject: "His and Hers program", body: "This will be content for our His&Hers Divorce Advocates Program.", at: ago(56) });
    inbox("info", { id: "g-office", thread: "t-office", from: OLIVIA, to: "info@realtourpilot.com", subject: "Harrison Equipment", body: `Harrison left a battery and charging cord behind yesterday.${SIG}`, at: ago(55) });
    // An unknown sender in info@ (a stranger on the team's own domain too), and a solo client.
    inbox("info", { id: "g-stranger", thread: "t-stranger", from: "Pat Neighbor <pat@nowhere.invalid>", to: "info@realtourpilot.com", subject: "1337 Carolannes Way", body: "Who filmed 1337 Carolannes Way? Love it.", at: ago(54) });
    inbox("info", { id: "g-newhire", thread: "t-newhire", from: "New Hire <newhire@gmtdrill.com>", to: "info@realtourpilot.com", subject: "34 Oakland Rd", body: "Hi, I just joined the team. Is 34 Oakland Rd done?", at: ago(53) });
    inbox("info", { id: "g-solo", thread: "t-solo", from: "Sam Solo <sam.solo@gmail.com>", to: "info@realtourpilot.com", subject: "Saw your work", body: "I loved the video for 1337 Carolannes Way. Can mine at 77 Maple look like that?", at: ago(52) });
    // 5 · an ask in an email filed on Sharra (subject) that names Mike's job.
    inbox("hello", { id: "g-asks", thread: "t-asks", from: OLIVIA, to: "hello@realtourpilot.com", subject: "34 Oakland Rd edits", body: `Two things: slow down the drone clip, and can we move the 2 Quail Run shoot to Friday at 10?${SIG}`, at: ago(50) });
    decisions.push({ match: /move the 2 Quail Run shoot/, d: decide({ projectId: oakland.id, asks: [
      { kind: "SPECIAL_REQUEST", text: "Slow down the drone clip", summary: "Slow the drone clip", medium: "video", projectHint: oakland.id },
      { kind: "SCHEDULING", text: "Can we move the 2 Quail Run shoot to Friday at 10?", summary: "Move the 2 Quail Run shoot to Friday at 10", medium: "unclear", projectHint: null },
    ] }) });
    await google.syncGmail();
    const row = (ext: string) => prisma.commLog.findUnique({ where: { externalId: ext } });
    const at = async (ext: string) => { const r = await row(ext); return r ? `${r.clientName ?? "nobody"} / ${r.projectId ?? "no job"}${r.projectGuess ? " (guess)" : ""}` : "no row"; };

    c.head("2 · Gmail: her email goes to the agent whose job it names");
    {
      const s = await row("gmail-info@realtourpilot.com:g-sussex");
      c.ok("naming Sharra's 1337 Carolannes Way: on Sharra's job (not Mike's 913 Lakeview Ct)", s?.clientId === sharra.id && s.projectId === carolannes.id && !s.projectGuess, await at("gmail-info@realtourpilot.com:g-sussex"));
      c.ok("…her reply task is on Sharra, with Olivia as the person", !!(await prisma.smartTask.findFirst({ where: { clientId: sharra.id, contactName: "Olivia Vecere" } })) && !(await prisma.smartTask.findFirst({ where: { clientId: mike.id, description: { contains: "glitchy" } } })));
      const j = await row("gmail-info@realtourpilot.com:g-joe");
      c.ok("naming Joe's 2402 Hickory Hill Rd (his backup email is on the team domain): on Joe's job", j?.clientId === joe.id && j.projectId === hickory.id, await at("gmail-info@realtourpilot.com:g-joe"));
      const t = await row("gmail-info@realtourpilot.com:g-thread");
      c.ok("a listing link in the quoted thread (her words name nothing): on that listing's job", t?.clientId === sharra.id && t.projectId === carolannes.id, await at("gmail-info@realtourpilot.com:g-thread"));
      const q = await row("gmail-info@realtourpilot.com:g-quail");
      c.ok("naming Mike's own 2 Quail Run: stays with Mike, on that job", q?.clientId === mike.id && q.projectId === quail.id && !q.projectGuess, await at("gmail-info@realtourpilot.com:g-quail"));
      const n = await row("gmail-info@realtourpilot.com:g-none");
      c.ok("naming no job: goes to Mike (the parent), as before", n?.clientId === mike.id, await at("gmail-info@realtourpilot.com:g-none"));
      const o = await row("gmail-info@realtourpilot.com:g-office");
      c.ok("the team office in her signature only: Mike, not Sharra or Joe", o?.clientId === mike.id, await at("gmail-info@realtourpilot.com:g-office"));
    }

    c.head("3 · Gmail: our reply to her stays in her conversation");
    {
      fakeGoogle.sent.hello.push({ id: "s-sussex", thread: "t-sussex-h", from: US, to: OLIVIA, subject: "Re: New construction videos for Sussex", body: "Got it, on it today!", at: ago(40), inReplyTo: "<sussex@mail.invalid>" });
      await google.syncGmail();
      const r = await prisma.commLog.findFirst({ where: { direction: "out", subject: "Re: New construction videos for Sussex" } });
      c.ok("Kyle's \"on it\" (names no job) is logged on Sharra, where her email is, not on Mike", r?.clientId === sharra.id && r.projectId === carolannes.id, `${r?.clientName} / ${r?.projectId}`);
    }

    c.head("4 · Gmail: an unknown sender is never matched; a solo client is unchanged");
    {
      const s = await row("gmail-info@realtourpilot.com:g-stranger");
      c.ok("a stranger naming 1337 Carolannes Way in info@: no client, no job", !!s && s.clientId === null && s.projectId === null, await at("gmail-info@realtourpilot.com:g-stranger"));
      const h = await row("gmail-info@realtourpilot.com:g-newhire");
      c.ok("a stranger on the team's own domain naming 34 Oakland Rd: still no client (no row of hers to route from)", !!h && h.clientId === null, await at("gmail-info@realtourpilot.com:g-newhire"));
      const so = await row("gmail-info@realtourpilot.com:g-solo");
      c.ok("a solo client naming Sharra's 1337 Carolannes Way stays his own (77 Maple Ave)", so?.clientId === solo.id && so.projectId === soloJob.id, await at("gmail-info@realtourpilot.com:g-solo"));
    }

    c.head("5 · asks: each on the agent whose job it names");
    {
      const m = await row("gmail-hello@realtourpilot.com:g-asks");
      c.ok("the email (subject: 34 Oakland Rd) is Sharra's", m?.clientId === sharra.id && m.projectId === oakland.id, await at("gmail-hello@realtourpilot.com:g-asks"));
      const sched = await prisma.clientAsk.findFirst({ where: { kind: "SCHEDULING" } });
      c.ok("its ask \"move the 2 Quail Run shoot\" is filed on Mike's 2 Quail Run Ln, asked by Olivia", sched?.clientId === mike.id && sched.projectId === quail.id && sched.askedBy === "Olivia Vecere", `${sched?.clientId === mike.id ? "Mike" : sched?.clientId} / ${sched?.projectId === quail.id ? "Quail Run" : sched?.projectId} / ${sched?.askedBy}`);
      const special = await prisma.clientAsk.findFirst({ where: { kind: "SPECIAL_REQUEST" } });
      c.ok("…and \"slow down the drone clip\" (names no job) stays with the message, on Sharra's 34 Oakland Rd", special?.clientId === sharra.id && special.projectId === oakland.id, `${special?.clientId} / ${special?.projectId}`);
    }

    // =========================================================================
    // THE OPENPHONE RECEIVER: texts and call notes
    // =========================================================================
    const { processOpenPhoneEvent } = await import("@/lib/webhooks/openphone");
    const LINE = "+12155550100";
    const OLIVIA_PHONE = "+14845555714";
    const text = (id: string, from: string, body: string, to: string[] = [LINE]) => processOpenPhoneEvent("message.received", { data: { object: { id, direction: "incoming", from, to, text: body } } });
    const op = (id: string) => row(`op-${id}`);

    c.head("6 · OpenPhone texts");
    {
      await text("T-SUSSEX", OLIVIA_PHONE, "The 1337 Carolannes Way videos still need the people slowed down");
      const s = await op("T-SUSSEX");
      c.ok("her text naming Sharra's 1337 Carolannes Way: on Sharra's job", s?.clientId === sharra.id && s.projectId === carolannes.id && !s.projectGuess, await at("op-T-SUSSEX"));
      c.ok("…its reply task on Sharra, with Olivia as the person", !!(await prisma.smartTask.findFirst({ where: { clientId: sharra.id, source: "openphone", contactName: "Olivia Vecere" } })));
      // Kyle answers from his own handset (ours: a teammate texting an outside number).
      await processOpenPhoneEvent("message.received", { data: { object: { id: "T-REPLY", direction: "incoming", from: "+12155550199", to: [OLIVIA_PHONE], text: "On it, we'll have them today!" } } });
      const r = await op("T-REPLY");
      c.ok("our reply text (names no job) follows her conversation: Sharra, not Mike", r?.direction === "out" && r.clientId === sharra.id, `${r?.direction} ${r?.clientName}`);
      await text("T-QUAIL", OLIVIA_PHONE, "Is the 2 Quail Run shoot still on for Friday?");
      const q = await op("T-QUAIL");
      c.ok("her text naming Mike's own 2 Quail Run: Mike, on that job", q?.clientId === mike.id && q.projectId === quail.id, await at("op-T-QUAIL"));
      await text("T-NONE", OLIVIA_PHONE, "Thanks so much!");
      const n = await op("T-NONE");
      c.ok("her text naming no job: Mike (the parent), as before", n?.clientId === mike.id, await at("op-T-NONE"));
      await text("T-OFFICE", OLIVIA_PHONE, "Harrison left a charger at the office, 893 S Matlack St");
      const o = await op("T-OFFICE");
      c.ok("the team office (a job of two clients) names nobody: Mike", o?.clientId === mike.id, await at("op-T-OFFICE"));
      await text("T-STRANGER", "+12675550111", "Who filmed 1337 Carolannes Way?");
      const st = await op("T-STRANGER");
      c.ok("an unknown number naming 1337 Carolannes Way: no client", !!st && st.clientId === null, await at("op-T-STRANGER"));
      await text("T-SOLO", "+16105550180", "Loved 1337 Carolannes Way, can 77 Maple look like that?");
      const so = await op("T-SOLO");
      c.ok("a solo client's text naming another agent's job stays his own", so?.clientId === solo.id, await at("op-T-SOLO"));
    }

    c.head("7 · OpenPhone call notes");
    {
      await processOpenPhoneEvent("call.transcript.completed", { data: { object: { callId: "CALL-TEAM-1", direction: "incoming", from: OLIVIA_PHONE, to: LINE, dialogue: [
        { content: "Hi, it's Olivia. Joe wants the showcase for 2402 Hickory Hill Rd released today.", identifier: OLIVIA_PHONE },
        { content: "Sure, we'll take care of it.", userId: "US-DRILL", identifier: LINE },
      ] } } });
      const k = await row("op-call-CALL-TEAM-1");
      c.ok("her call naming Joe's 2402 Hickory Hill Rd: on Joe's job, not a guess", k?.clientId === joe.id && k.projectId === hickory.id && !k.projectGuess, await at("op-call-CALL-TEAM-1"));
      await processOpenPhoneEvent("call.transcript.completed", { data: { object: { callId: "CALL-TEAM-2", direction: "incoming", from: OLIVIA_PHONE, to: LINE, dialogue: [
        { content: "Hi, it's Olivia, just checking in about next week.", identifier: OLIVIA_PHONE },
        { content: "Sounds good.", userId: "US-DRILL", identifier: LINE },
      ] } } });
      const k2 = await row("op-call-CALL-TEAM-2");
      c.ok("a call naming no job: Mike, as before", k2?.clientId === mike.id, await at("op-call-CALL-TEAM-2"));
    }

    c.head("isolation");
    c.ok("only the faked Google was called", fence.blocked.length === 0, fence.blocked.join(", "));
    void lakeview;
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();
