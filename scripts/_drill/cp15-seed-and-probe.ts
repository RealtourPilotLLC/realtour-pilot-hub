// ---------------------------------------------------------------------------
// DRILL: CP-15 — the representative TEST month, and the sending mailbox
// (completion audit batch E, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp15-seed-and-probe.ts
//
// WHAT IS ASSERTED, IN ORDER (the OLD behaviour first where it can be seen):
//   1. Gmail strict mode, every web call fenced. OLD: asked for info@ with only
//      hello@ connected, sendGmailNew requests a token for hello@ — the
//      program email would leave from the wrong mailbox. NEW: with `strict`
//      it answers not-connected (needsReconnect, 401) and requests no token;
//      the outbox's email rail passes strict and turns that into a clean,
//      re-offerable refusal. With info@ connected, strict sends from info@.
//   2. Refusals, each before a single row is written: a client without TEST
//      in its name; a protected real client id renamed "… TEST"; an
//      unverified email on the client and on the portal seat; the full tier on
//      a hosted-looking DATABASE_URL; a past month.
//   3. The program tier: what it builds (no Project, the five topics in their
//      states, the carry), then run TWICE — identical row counts for every
//      model in the schema — and a third time with a hosted-looking URL in the
//      environment, which the program tier (unlike the full tier) accepts.
//   4. The full tier, Accelerator: four cuts in four states, a revision round,
//      a delivery; last month's two deliveries; seeded twice, same counts.
//   5. Pro and Ended variants: two distinct confirmed sessions; an ended
//      program that keeps its library.
//   3b. A FUTURE month on the program tier (Sep 24, finding 7): "last month" is
//      then the live current month, and it is left OPEN — never closed by a
//      raw update, E never selected into it or carried out of it; E goes
//      straight onto the seeded month.
//   4b. The month's order and identity (Sep 24, findings 3/11/12): the call a
//      week BEFORE the shoot; the first session request is the filmed morning,
//      confirmed on the job with no future slot, and the portal schedule offers
//      no "Change time" on it; the filming report landed — every library video
//      of both months carries its topic as its title, A–D are FILMED, the
//      office's Sessions view counts 4 confirmed, and last month's delivered
//      videos have a released script for the caption assistant.
//   6. Cross-screen agreement on every seeded month: portalTopics,
//      portalPlanning, portalScheduleMonths, portalVideoList,
//      programCountsByMonth, monthProgress and programOverview give the same
//      selected / scripted / approved / sessions / delivered numbers, and each
//      interview's stage matches its script's state.
//
// ISOLATION. _harness.ts: PGlite on 127.0.0.1:5531 (DRILL_PORT overrides),
// every .env secret blanked, fetch AND raw sockets fenced to loopback; the
// only answered hosts are Google's token and Gmail send endpoints, faked in
// section 1. No provider is reached and no message is sent.
// ---------------------------------------------------------------------------
import { Prisma } from "@prisma/client";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5531);
installNextStubs();

// Section 1 answers Google's two endpoints itself, so the drill can see WHICH
// refresh token was spent and which access token signed the send.
let google: ((url: string, init?: RequestInit) => Response | null) | null = null;
const fence = fenceFetch((url, init) => (google ? google(url, init) : null));
const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const fx = await import("../_fixtures/representativeMonth");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const MK = etMonthKey(new Date());

  /** Every model's row count — the idempotency yardstick. */
  const models = Prisma.dmmf.datamodel.models.map((m) => m.name);
  const countAll = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const m of models) {
      const delegate = (prisma as unknown as Record<string, { count: () => Promise<number> }>)[m.charAt(0).toLowerCase() + m.slice(1)];
      out[m] = await delegate.count();
    }
    return out;
  };
  const diff = (a: Record<string, number>, b: Record<string, number>) =>
    Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k} ${a[k]}→${b[k]}`);
  const refusedWith = async (p: Promise<unknown>): Promise<string> => p.then(() => "no error", (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)));

  // =========================================================================
  c.head("1 · Gmail: the sending mailbox is info@, or nothing");
  // =========================================================================
  {
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { sendGmailNew } = await import("@/lib/integrations/google");
    const { realOutboxProvider, OutboxSendError } = await import("@/lib/outbox");
    const spent: string[] = [];
    const sentWith: string[] = [];
    google = (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") {
        const refresh = (init?.body as URLSearchParams | undefined)?.get?.("refresh_token") ?? "?";
        spent.push(refresh);
        return new Response(JSON.stringify({ access_token: `access-for-${refresh}`, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        sentWith.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""));
        return new Response(JSON.stringify({ id: `gm-${sentWith.length}` }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return null;
    };
    await saveSecret("gmail", JSON.stringify({ "hello@realtourpilot.com": "refresh-hello-1" }));
    const msg = { mailbox: "info@realtourpilot.com", to: "info+drill@realtourpilot.com", subject: "Drill", body: "Drill body" };

    const old = await sendGmailNew(msg);
    c.ok("OLD: info@ missing — the send still went out", old.ok === true, JSON.stringify(old));
    c.ok("OLD: …on a token minted for hello@, the first account in the map", spent.join() === "refresh-hello-1" && sentWith.join() === "Bearer access-for-refresh-hello-1", `tokens: ${spent.join()} · auth: ${sentWith.join()}`);

    spent.length = 0; sentWith.length = 0;
    await saveSecret("gmail", JSON.stringify({ "hello@realtourpilot.com": "refresh-hello-2" }));
    const strict = await sendGmailNew({ ...msg, strict: true });
    c.ok("NEW: strict — not connected, needsReconnect, 401", !strict.ok && strict.needsReconnect === true && strict.status === 401, JSON.stringify(strict));
    c.ok("NEW: …and no token was even requested, nothing sent", spent.length === 0 && sentWith.length === 0, `tokens: ${spent.join() || "none"} · sends: ${sentWith.length}`);

    let thrown: unknown = null;
    try {
      await realOutboxProvider().send({ channel: "email", toRef: "info+drill@realtourpilot.com", body: "Drill", dedupeKey: "program_message:drill:1", extraToRefsJson: null, mediaUrlsJson: null });
    } catch (e) { thrown = e; }
    const ose = thrown instanceof OutboxSendError ? thrown : null;
    c.ok("the outbox's email rail refuses cleanly (OutboxSendError, not ambiguous — it can be offered again)", !!ose && ose.ambiguous === false && ose.status === 401, ose ? `${ose.message} · ambiguous=${ose.ambiguous} · ${ose.status}` : String(thrown));
    c.ok("…still without touching Google", spent.length === 0 && sentWith.length === 0);

    await saveSecret("gmail", JSON.stringify({ "hello@realtourpilot.com": "refresh-hello-3", "info@realtourpilot.com": "refresh-info-3" }));
    const good = await sendGmailNew({ ...msg, strict: true });
    c.ok("with info@ connected, strict sends — from info@'s own token", good.ok === true && spent.join() === "refresh-info-3" && sentWith.join() === "Bearer access-for-refresh-info-3", `tokens: ${spent.join()} · auth: ${sentWith.join()}`);
    google = null;
    await prisma.connection.deleteMany({ where: { provider: "gmail" } });
  }

  // =========================================================================
  c.head("2 · refusals — each before a single row is written");
  // =========================================================================
  {
    const real = await prisma.client.create({ data: { name: "Maple Realty Group", email: "info+maple@realtourpilot.com" }, select: { id: true } });
    await prisma.contentEnrollment.create({ data: { clientId: real.id, package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2, status: "ACTIVE" } });
    const renamed = await prisma.client.create({ data: { id: "cmqikskt1008u9k9qej9ltjy5", name: "Jordan Spackman TEST", email: "info+jordantest@realtourpilot.com" }, select: { id: true } });
    await prisma.contentEnrollment.create({ data: { clientId: renamed.id, package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2, status: "ACTIVE" } });
    const badEmail = await fx.createTestClientShell(prisma, { name: "Unverified TEST", slug: "unverified", email: "someone@example.com" });
    const badSeat = await fx.createTestClientShell(prisma, { name: "Seat TEST", slug: "seat" });
    await prisma.clientUser.update({ where: { id: badSeat.clientUserId }, data: { email: "assistant@example.com" } });
    const ok = await fx.createTestClientShell(prisma, { name: "Hosted Guard TEST", slug: "hostedguard" });

    const before = await countAll();
    const r1 = await refusedWith(fx.seedRepresentativeMonth(prisma, { clientId: real.id, monthKey: MK, tier: "program", variant: "accelerator" }));
    c.ok("a client without TEST in its name", /NotATestClientError/.test(r1), r1.slice(0, 140));
    const r2 = await refusedWith(fx.seedRepresentativeMonth(prisma, { clientId: renamed.id, monthKey: MK, tier: "program", variant: "accelerator" }));
    c.ok("a protected real id renamed \"Jordan Spackman TEST\" — refused by its id", /RealClientError/.test(r2), r2.slice(0, 140));
    const r3 = await refusedWith(fx.seedRepresentativeMonth(prisma, { clientId: badEmail.clientId, monthKey: MK, tier: "program", variant: "accelerator" }));
    c.ok("an unverified email on the client", /NotAVerifiedTestDestinationError/.test(r3), r3.slice(0, 140));
    const r4 = await refusedWith(fx.seedRepresentativeMonth(prisma, { clientId: badSeat.clientId, monthKey: MK, tier: "program", variant: "accelerator" }));
    c.ok("an unverified email on the portal seat", /NotAVerifiedTestDestinationError/.test(r4), r4.slice(0, 140));

    const saved = { DATABASE_URL: process.env.DATABASE_URL, DIRECT_URL: process.env.DIRECT_URL };
    process.env.DATABASE_URL = "postgresql://owner:secret@ep-drill-123.us-east-2.aws.neon.tech/neondb?sslmode=require";
    const r5 = await refusedWith(fx.seedRepresentativeMonth(prisma, { clientId: ok.clientId, monthKey: MK, tier: "full", variant: "accelerator" }));
    process.env.DATABASE_URL = saved.DATABASE_URL;
    c.ok("the full tier on a hosted-looking DATABASE_URL", /hosted database/.test(r5), r5.slice(0, 160));
    process.env.DIRECT_URL = "postgresql://u:p@db.vercel-storage.com/x";
    const r5b = await refusedWith(fx.seedRepresentativeMonth(prisma, { clientId: ok.clientId, monthKey: MK, tier: "full", variant: "pro" }));
    process.env.DIRECT_URL = saved.DIRECT_URL;
    c.ok("…or a hosted-looking DIRECT_URL", /hosted database/.test(r5b), r5b.slice(0, 160));
    const [y, m] = MK.split("-").map(Number);
    const pastKey = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}`;
    const r6 = await refusedWith(fx.seedRepresentativeMonth(prisma, { clientId: ok.clientId, monthKey: pastKey, tier: "program", variant: "accelerator" }));
    c.ok("a past month", /in the past/.test(r6), r6.slice(0, 140));
    const after = await countAll();
    c.ok("not one row was written by any of the refusals", diff(before, after).length === 0, diff(before, after).join(", ") || "identical");
    c.ok("and the hosted URL was never dialled", !fence.blocked.some((u) => /neon\.tech|vercel-storage/.test(u)), fence.blocked.join(", ") || "nothing blocked");
  }

  // =========================================================================
  c.head("3 · the program tier: what it builds, and twice is once");
  // =========================================================================
  const cara = await fx.createTestClientShell(prisma, { name: "Cara TEST", slug: "cara" });
  const projectsBefore = await prisma.project.count();
  const seed1 = await fx.seedRepresentativeMonth(prisma, { clientId: cara.clientId, monthKey: MK, tier: "program", variant: "accelerator" });
  {
    c.ok("it wrote (first run)", seed1.wrote.length > 20, `${seed1.wrote.length} steps`);
    c.ok("the program tier created NO Project", (await prisma.project.count()) === projectsBefore);
    const e = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: cara.enrollmentId } });
    c.ok("the package moved to Accelerator through the ledger", e.package === "Accelerator" && e.videosPerMonth === 4 && (await prisma.programEnrollmentChange.count({ where: { enrollmentId: e.id, field: "package" } })) === 1, `${e.package} ${e.videosPerMonth}`);
    const v = await prisma.contentStrategyVersion.findFirstOrThrow({ where: { enrollmentId: e.id } });
    c.ok("an approved, released strategy", v.status === "APPROVED" && !!v.releasedAt);
    const pillars = await prisma.contentPillar.count({ where: { enrollmentId: e.id } });
    const approved = await prisma.contentTopic.count({ where: { enrollmentId: e.id, approvalState: "APPROVED" } });
    const proposed = await prisma.contentTopic.count({ where: { enrollmentId: e.id, approvalState: "PROPOSED" } });
    c.ok("3 pillars, 30 approved topics, 2 proposed", pillars === 3 && approved === 30 && proposed === 2, `${pillars} / ${approved} / ${proposed}`);
    const sel = await prisma.contentTopicSelection.findMany({ where: { monthId: seed1.monthId }, select: { topicId: true, status: true, source: true, overflow: true } });
    const of = (t: string) => sel.find((s) => s.topicId === t);
    c.ok("A and B selected from the call, C and D by the client", of(seed1.topics.A)?.source === "call" && of(seed1.topics.B)?.source === "call" && of(seed1.topics.C)?.source === "client" && of(seed1.topics.D)?.source === "client");
    c.ok("E CARRIED in from last month — the fifth on a 4-video month, kept and flagged", of(seed1.topics.E)?.status === "CARRIED" && of(seed1.topics.E)?.overflow === true && sel.filter((s) => s.overflow).length === 1, JSON.stringify(of(seed1.topics.E)));
    const last = await prisma.contentMonth.findUniqueOrThrow({ where: { id: seed1.lastMonthId } });
    c.ok("last month COMPLETED", last.status === "COMPLETED");
    const iv = await prisma.contentInterview.findMany({ where: { id: { in: [seed1.interviews.C, seed1.interviews.D] } }, select: { id: true, status: true } });
    c.ok("C's answers SUBMITTED, D's NEEDS_FOLLOWUP", iv.find((x) => x.id === seed1.interviews.C)?.status === "SUBMITTED" && iv.find((x) => x.id === seed1.interviews.D)?.status === "NEEDS_FOLLOWUP", JSON.stringify(iv.map((x) => x.status)));
    const scripts = await prisma.contentScript.findMany({ where: { id: { in: Object.values(seed1.scripts) } }, select: { id: true, releaseState: true, clientApprovedVersionId: true, clientChangesAt: true, monthId: true } });
    const s = (id: string) => scripts.find((x) => x.id === id)!;
    c.ok("A released and approved by the client", s(seed1.scripts.A).releaseState === "released" && !!s(seed1.scripts.A).clientApprovedVersionId);
    c.ok("B released with a change requested", s(seed1.scripts.B).releaseState === "released" && !!s(seed1.scripts.B).clientChangesAt && !s(seed1.scripts.B).clientApprovedVersionId);
    c.ok("C a draft waiting on Jordan (never released)", s(seed1.scripts.C).releaseState !== "released");
    c.ok("E released, waiting on the client, now filed on this month", s(seed1.scripts.E).releaseState === "released" && !s(seed1.scripts.E).clientApprovedVersionId && !s(seed1.scripts.E).clientChangesAt && s(seed1.scripts.E).monthId === seed1.monthId);
    c.ok("D has no script (thin answers draft nothing)", (await prisma.contentScript.count({ where: { topicId: seed1.topics.D } })) === 0);
    const reqs = await prisma.programSessionRequest.findMany({ where: { enrollmentId: e.id }, select: { status: true, slotStart: true } });
    c.ok("one session request, REQUESTED", reqs.length === 1 && reqs[0].status === "REQUESTED", JSON.stringify(reqs));
    const etMonthOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).format(d).slice(0, 7);
    c.ok("…on a weekday INSIDE the month (or a free-text ask when none is left) — never next month's date", !reqs[0].slotStart || (etMonthOf(reqs[0].slotStart) === MK && reqs[0].slotStart > new Date()), reqs[0].slotStart?.toISOString() ?? "free text");
    const call = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: seed1.callRecordId } });
    c.ok("the call is COMPLETED, confirmed, on this month, with its transcript", call.status === "COMPLETED" && call.monthId === seed1.monthId && (await prisma.programTranscriptSource.count({ where: { callRecordId: call.id, matchState: "CONFIRMED" } })) === 1, `${call.status} ${call.transcriptState}`);
    c.ok("no appointment, no Aryeo id anywhere on the client", (await prisma.appointment.count({ where: { project: { clientId: cara.clientId } } })) === 0 && (await prisma.client.findUniqueOrThrow({ where: { id: cara.clientId } })).aryeoCustomerId === null);
    c.ok("nothing was queued to send", (await prisma.outboxMessage.count()) === 0);
  }
  {
    const before = await countAll();
    const seed2 = await fx.seedRepresentativeMonth(prisma, { clientId: cara.clientId, monthKey: MK, tier: "program", variant: "accelerator" });
    const after = await countAll();
    c.ok("seeded twice: identical row counts for every model", diff(before, after).length === 0, diff(before, after).join(", ") || `${models.length} models identical`);
    c.ok("…and the second run reports nothing written", seed2.wrote.length === 0, seed2.wrote.join(" | "));
    c.ok("…and hands back the same ids", JSON.stringify(seed2.topics) === JSON.stringify(seed1.topics) && JSON.stringify(seed2.scripts) === JSON.stringify(seed1.scripts));
    // The program tier is the one allowed on the live hub: a hosted-looking URL
    // in the environment is not a reason for IT to refuse (the connection
    // itself is still this drill's; the fence would stop anything else).
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://owner:secret@ep-drill-123.us-east-2.aws.neon.tech/neondb?sslmode=require";
    const r = await refusedWith(fx.seedRepresentativeMonth(prisma, { clientId: cara.clientId, monthKey: MK, tier: "program", variant: "accelerator" }));
    process.env.DATABASE_URL = saved;
    c.ok("the program tier is not refused by a hosted-looking URL", r === "no error", r.slice(0, 140));
    c.ok("…and a third run changed nothing either", diff(before, await countAll()).length === 0);
  }

  // =========================================================================
  c.head("3b · a FUTURE month leaves the live current month alone");
  // =========================================================================
  {
    const [y, m] = MK.split("-").map(Number);
    const nextKey = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;
    const fern = await fx.createTestClientShell(prisma, { name: "Fern TEST", slug: "fern" });
    const lines: string[] = [];
    const fut = await fx.seedRepresentativeMonth(prisma, { clientId: fern.clientId, monthKey: nextKey, tier: "program", variant: "accelerator", log: (l) => lines.push(l) });
    const cur = await prisma.contentMonth.findUniqueOrThrow({ where: { id: fut.lastMonthId } });
    c.ok("seeding next month: 'last month' is this ET month, and it is still OPEN (no raw COMPLETED)", fut.lastMonthKey === MK && cur.status === "OPEN", `${fut.lastMonthKey} ${cur.status}`);
    const eSels = await prisma.contentTopicSelection.findMany({ where: { topicId: fut.topics.E }, select: { monthId: true, status: true } });
    c.ok("E was never selected into the live month, nor carried out of it — it is on next month, SELECTED", eSels.length === 1 && eSels[0].monthId === fut.monthId && eSels[0].status === "SELECTED", JSON.stringify(eSels));
    c.ok("the live month holds no selection the fixture made", (await prisma.contentTopicSelection.count({ where: { monthId: cur.id } })) === 0);
    c.ok("E's script is released and filed on next month", (await prisma.contentScript.findUniqueOrThrow({ where: { id: fut.scripts.E } })).monthId === fut.monthId);
    c.ok("the log says so, in words", lines.some((l) => /live current month — left OPEN and untouched/.test(l)), lines.find((l) => /live current month/.test(l)) ?? "(no line)");
  }

  // =========================================================================
  c.head("4 · the full tier (Accelerator): cuts in four states, deliveries");
  // =========================================================================
  const dora = await fx.createTestClientShell(prisma, { name: "Dora TEST", slug: "dora" });
  const full1 = await fx.seedRepresentativeMonth(prisma, { clientId: dora.clientId, monthKey: MK, tier: "full", variant: "accelerator" });
  {
    const cuts = full1.cuts!;
    const p = await prisma.project.findUniqueOrThrow({ where: { id: full1.projectId! } });
    c.ok("this month's Project is MANUAL, no Aryeo order", p.source === "MANUAL" && p.aryeoOrderId === null && p.contentMonthId === full1.monthId);
    const sub = async (id: string) => prisma.reviewSubmission.findUniqueOrThrow({ where: { id } });
    const win = async (id: string) => prisma.contentReviewWindow.findUnique({ where: { submissionId: id } });
    const dec = async (id: string) => prisma.clientDecision.findMany({ where: { submissionId: id }, select: { decision: true } });
    c.ok("A released and waiting on the client", !!(await sub(cuts.A)).clientReleasedAt && (await win(cuts.A))?.state === "OPEN" && (await dec(cuts.A)).length === 0);
    const bWin = await win(cuts.B);
    const round = await prisma.contentRevisionRound.findFirst({ where: { submissionId: cuts.B } });
    const brief = await prisma.revisionBrief.count({ where: { submissionId: cuts.B } });
    c.ok("B sent back: a REQUEST_CHANGES decision, round 1, a revision brief", (await dec(cuts.B)).map((d) => d.decision).join() === "REQUEST_CHANGES" && round?.ordinal === 1 && brief >= 1, `window ${bWin?.state} · round ${round?.ordinal} · briefs ${brief}`);
    const b2 = await sub(cuts.B2);
    c.ok("…and B's round 2 is in, waiting in the Review Room (not released)", b2.status === "PENDING" && !b2.clientReleasedAt && b2.round === 2);
    const ce = await import("@/lib/cutEntitlement");
    const pair = { id: full1.enrollmentId, clientId: full1.clientId };
    c.ok("C approved by the client — download unlocked", (await dec(cuts.C)).map((d) => d.decision).join() === "APPROVE" && (await ce.cutDownloadableFor(pair, cuts.C)));
    c.ok("A is not downloadable (awaiting the client)", !(await ce.cutDownloadableFor(pair, cuts.A)));
    const d = await sub(cuts.D);
    c.ok("D approved and sent", (await dec(cuts.D)).map((x) => x.decision).join() === "APPROVE" && !!d.sentToClientAt);
    const vids = await prisma.contentVideo.findMany({ where: { enrollmentId: full1.enrollmentId, status: { not: "ARCHIVED" } }, select: { monthKey: true, status: true, deliveredAt: true } });
    const byMonth = (k: string) => vids.filter((v) => v.monthKey === k);
    c.ok("the library: this month A in review, B editing, C approved, D delivered", byMonth(full1.monthKey).map((v) => v.status).sort().join() === "APPROVED,CLIENT_REVIEW,DELIVERED,EDITING", byMonth(full1.monthKey).map((v) => v.status).sort().join());
    c.ok("last month: two delivered videos", byMonth(full1.lastMonthKey).filter((v) => v.status === "DELIVERED").length === 2, byMonth(full1.lastMonthKey).map((v) => v.status).join());
    const req = await prisma.programSessionRequest.findMany({ where: { enrollmentId: full1.enrollmentId }, select: { status: true, projectId: true } });
    c.ok("the session request is confirmed on this month's job", req.length === 1 && req[0].status === "CONFIRMED" && req[0].projectId === full1.projectId, JSON.stringify(req));
    c.ok("still no appointment, no provider id", (await prisma.appointment.count({ where: { project: { clientId: dora.clientId } } })) === 0);

    // ---- 4b · the order of the month, and what each video IS ----------------
    const call = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: full1.callRecordId } });
    const heldAt = call.scheduledStart;
    c.ok("the planning call was held BEFORE the shoot (a week before; it used to be the day after)", !!p.shootDate && !!heldAt && heldAt < p.shootDate && p.shootDate.getTime() - heldAt.getTime() >= 6 * 86_400_000, `call ${heldAt?.toISOString()} · shoot ${p.shootDate?.toISOString()}`);
    const r1 = await prisma.programSessionRequest.findFirstOrThrow({ where: { enrollmentId: full1.enrollmentId }, orderBy: { createdAt: "asc" } });
    c.ok("the one session request is the filmed morning, confirmed on the job — no future slot on a past job", r1.status === "CONFIRMED" && r1.projectId === full1.projectId && (!r1.slotStart || r1.slotStart <= p.shootDate!), `${r1.status} ${r1.slotStart?.toISOString() ?? "no slot"}`);
    const portal = await import("@/lib/portal");
    const schedMonth = (await portal.portalScheduleMonths(pair)).find((x) => x.monthId === full1.monthId);
    c.ok("the portal schedule offers no Change time / Cancel on it (held, not booked)", !!schedMonth && !schedMonth.requests.some((x) => x.status === "CONFIRMED" && x.canChange), JSON.stringify(schedMonth?.requests.map((x) => [x.status, x.canChange])));
    const topicRows = await prisma.contentTopic.findMany({ where: { id: { in: [full1.topics.A, full1.topics.B, full1.topics.C, full1.topics.D] } }, select: { id: true, title: true, status: true } });
    const titleOf = new Map(topicRows.map((t) => [t.id, t.title]));
    const lib = await prisma.contentVideo.findMany({ where: { enrollmentId: full1.enrollmentId, status: { not: "ARCHIVED" } }, select: { monthKey: true, slot: true, topicId: true, scriptId: true, title: true, filmedConfirmedAt: true } });
    const nowVids = lib.filter((v) => v.monthKey === full1.monthKey).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
    const order = [full1.topics.A, full1.topics.B, full1.topics.C, full1.topics.D];
    c.ok("this month: 4 videos, slot N is topic N (A–D), each titled by its topic — not a file name", nowVids.length === 4 && nowVids.every((v, i) => v.topicId === order[i] && v.title === titleOf.get(order[i]) && !!v.filmedConfirmedAt), nowVids.map((v) => `${v.slot}:${v.title}`).join(" | "));
    c.ok("…and no library title is a file name any more", !lib.some((v) => /\bvideo\d\b|\d{4} \d{2}/.test(v.title ?? "")), lib.map((v) => v.title).join(" | "));
    c.ok("A–C carry their script; D (thin answers) honestly has none", nowVids[0].scriptId === full1.scripts.A && nowVids[1].scriptId === full1.scripts.B && nowVids[2].scriptId === full1.scripts.C && nowVids[3].scriptId === null);
    c.ok("A–D are FILMED topics now (the confirmed-filmed state exists)", topicRows.every((t) => t.status === "FILMED"), topicRows.map((t) => t.status).join());
    const report = await prisma.contentFilmingReport.findMany({ where: { projectId: full1.projectId! }, select: { state: true } });
    c.ok("through the upload page's own report — one APPLIED filming report on the job", report.length === 1 && report[0].state === "APPLIED", JSON.stringify(report));
    const wd = await import("@/app/content/[id]/workspaceData");
    const sess = await wd.loadSessionsView({ id: full1.monthId });
    c.ok("the office's Production › Sessions counts 4 topics confirmed filmed on the job", sess.projects.find((x) => x.id === full1.projectId)?.topicsConfirmedHere === 4, JSON.stringify(sess.projects.map((x) => x.topicsConfirmedHere)));
    const lastVids = lib.filter((v) => v.monthKey === full1.lastMonthKey);
    c.ok("last month: both delivered videos carry a topic, its title and a script", lastVids.length === 2 && lastVids.every((v) => !!v.topicId && !!v.scriptId && !/video\d/.test(v.title ?? "")), lastVids.map((v) => v.title).join(" | "));
    const pk = await import("@/lib/postingKit");
    const cvx = await import("@/lib/contentVideos");
    const viewer = {
      enrollment: { id: full1.enrollmentId, clientId: full1.clientId, clientName: "Dora TEST", status: "ACTIVE", videosPerMonth: 4, sessionsPerMonth: 1 },
      actor: { kind: "CLIENT" as const, clientUserId: dora.clientUserId, email: "info+doratest@realtourpilot.com", name: "Dora TEST", membershipId: dora.membershipId, membershipRole: "OWNER" as const },
      access: "FULL" as const, via: "LOGIN" as const,
    };
    const kits = [];
    for (const v of await prisma.contentVideo.findMany({ where: { enrollmentId: full1.enrollmentId, monthKey: full1.lastMonthKey, status: { not: "ARCHIVED" } }, select: { id: true } })) {
      const row = await cvx.videoForEnrollment(pair, v.id);
      kits.push(row ? await pk.postingKitFor(viewer as Parameters<typeof pk.postingKitFor>[0], row) : null);
    }
    c.ok("the caption assistant has words to draft from on last month's delivered videos (it used to say 'nothing factual')", kits.length === 2 && kits.every((k) => !!k?.script?.body && k.access.captions), kits.map((k) => `${k?.script ? "script" : "none"}/${k?.access.captions}`).join(" "));

    const before = await countAll();
    const again = await fx.seedRepresentativeMonth(prisma, { clientId: dora.clientId, monthKey: MK, tier: "full", variant: "accelerator" });
    const after = await countAll();
    c.ok("the full tier seeded twice: identical row counts for every model", diff(before, after).length === 0, diff(before, after).join(", ") || "identical");
    c.ok("…nothing written the second time", again.wrote.length === 0, again.wrote.join(" | "));
  }

  // =========================================================================
  c.head("5 · Pro: two distinct confirmed 4-hour sessions · Ended: the library stays");
  // =========================================================================
  const pro = await fx.createTestClientShell(prisma, { name: "Pria TEST", slug: "pria" });
  const proSeed = await fx.seedRepresentativeMonth(prisma, { clientId: pro.clientId, monthKey: MK, tier: "full", variant: "pro" });
  const ended = await fx.createTestClientShell(prisma, { name: "Edie TEST", slug: "edie" });
  const endSeed = await fx.seedRepresentativeMonth(prisma, { clientId: ended.clientId, monthKey: MK, tier: "full", variant: "ended" });
  const mp = await import("@/lib/monthProgress");
  {
    const reqs = await prisma.programSessionRequest.findMany({ where: { enrollmentId: proSeed.enrollmentId }, orderBy: { createdAt: "asc" }, select: { status: true, slotStart: true, slotEnd: true, projectId: true } });
    const slotted = reqs.filter((r) => r.slotStart && r.slotEnd);
    const hours = slotted.map((r) => (r.slotEnd!.getTime() - r.slotStart!.getTime()) / 3_600_000);
    const etMonthOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).format(d).slice(0, 7);
    c.ok("Pro: two requests, both CONFIRMED — the filmed one on the job, a second 4-hour one", reqs.length === 2 && reqs.every((r) => r.status === "CONFIRMED") && reqs[0].projectId === proSeed.projectId && hours.every((h) => h === 4), JSON.stringify(reqs.map((r) => r.status)) + ` ${hours.join("/")}h`);
    c.ok("Pro: the second session is dated INSIDE this month (it used to land in the next one late in a month)", !reqs[1].slotStart || etMonthOf(reqs[1].slotStart) === MK, reqs[1].slotStart?.toISOString() ?? "free text");
    const p = (await mp.monthProgress(proSeed.enrollmentId, proSeed.monthId))!;
    c.ok("Pro: monthProgress counts 2 confirmed of 2, fully scheduled", p.sessions.required === 2 && p.sessions.confirmed === 2 && p.sessions.missing === 0 && p.sessions.fullyScheduled, JSON.stringify({ req: p.sessions.required, conf: p.sessions.confirmed, miss: p.sessions.missing }));
    const e = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: endSeed.enrollmentId } });
    c.ok("Ended: the program is ENDED, through the ledgered status change", e.status === "ENDED" && (await prisma.programEnrollmentChange.count({ where: { enrollmentId: e.id, field: "status" } })) === 1);
    const { portalVideoList } = await import("@/lib/contentVideos");
    const lib = await portalVideoList({ id: e.id, clientId: e.clientId });
    c.ok("Ended: the library is intact — 3 delivered + 1 approved still downloadable", lib.rows.filter((r) => r.downloadable).length === 4, lib.rows.map((r) => `${r.monthKey}:${r.state}${r.downloadable ? "↓" : ""}`).join(" "));
    const before = await countAll();
    const again = await fx.seedRepresentativeMonth(prisma, { clientId: ended.clientId, monthKey: MK, tier: "full", variant: "ended" });
    c.ok("Ended seeded again: nothing to do, identical counts", again.wrote.length === 0 && diff(before, await countAll()).length === 0, diff(before, await countAll()).join(", "));
  }

  // =========================================================================
  c.head("6 · every screen tells the same story about each seeded month");
  // =========================================================================
  {
    const portal = await import("@/lib/portal");
    const cv = await import("@/lib/contentVideos");
    const { programOverview } = await import("@/lib/programOverview");
    const now = new Date();
    // includeEnded: the Ended variant is a row Jordan sees with that filter on.
    const overview = await programOverview({ monthKey: MK, now, includeEnded: true });
    for (const s of [seed1, full1, proSeed, endSeed]) {
      const who = `${s.tier}/${s.variant}`;
      const pair = { id: s.enrollmentId, clientId: s.clientId };
      const prog = (await mp.monthProgress(s.enrollmentId, s.monthId, { now }))!;
      const row = overview.rows.find((r) => r.enrollmentId === s.enrollmentId);
      const topics = await portal.portalTopics(pair);
      const tm = topics.months.find((m) => m.id === s.monthId);
      const onMonth = topics.groups.flatMap((g) => g.topics).filter((t) => t.selection?.monthId === s.monthId);
      const decided = (d: string) => onMonth.filter((t) => t.script?.decision === d).length;
      const sched = (await portal.portalScheduleMonths(pair)).find((m) => m.monthId === s.monthId);
      const planning = await portal.portalPlanning(pair, s.monthId);
      const counts = (await cv.programCountsByMonth(s.enrollmentId, [s.monthKey, s.lastMonthKey]));
      const lib = await cv.portalVideoList(pair, { perPage: 50 });
      // "Delivered" is one rule (isDeliveredProgramVideo): the client HAS the
      // file — approved with the download unlocked, or sent. The library row's
      // own word for C is "Approved"; its downloadable flag is the same fact.
      const libDelivered = (k: string) => lib.rows.filter((r) => r.monthKey === k && r.countsTowardAllowance && r.downloadable).length;

      console.log(`    ${who}: selected ${tm?.selected}+${tm?.overflow} over (portal) · ${prog.topics.selected} incl. ${prog.topics.overflow} over (progress) · ${row?.work.topicsSelected} (overview) | ` +
        `client-approved ${decided("APPROVED")}/${prog.scripts.clientApproved} | changes ${decided("CHANGES_REQUESTED")}/${prog.scripts.changesRequested} | ` +
        `sessions ${sched?.sessionsRequired}-${sched?.sessionsMissing}/${prog.sessions.required}-${prog.sessions.missing}/${row?.session.required}-${row?.session.missing} | ` +
        `delivered ${libDelivered(s.monthKey)}/${counts.get(s.monthKey)?.delivered}/${prog.production.delivered}/${row?.production.delivered}`);

      c.ok(`${who}: the overview lists the month`, !!row && !!tm && !!sched && !!planning, `${!!row} ${!!tm} ${!!sched} ${!!planning}`);
      // The portal's month card counts within-allowance and overflow apart
      // (monthCapacity); monthProgress and the overview count every topic on
      // the month and say how many are over. Same five topics, same one over.
      c.ok(`${who}: selected — portal month card = monthProgress = overview`,
        tm!.selected + tm!.overflow === prog.topics.selected && tm!.overflow === prog.topics.overflow && row!.work.topicsSelected === prog.topics.selected,
        `${tm!.selected}+${tm!.overflow} / ${prog.topics.selected}+${prog.topics.overflow} / ${row!.work.topicsSelected}`);
      c.ok(`${who}: topics on the month — portal rows = the month card's count`, onMonth.length === tm!.selected + tm!.overflow, `${onMonth.length} rows`);
      c.ok(`${who}: client-approved scripts — portal verdicts = monthProgress (1)`, decided("APPROVED") === prog.scripts.clientApproved && prog.scripts.clientApproved === 1, `${decided("APPROVED")} / ${prog.scripts.clientApproved}`);
      c.ok(`${who}: change requests — portal verdicts = monthProgress (1)`, decided("CHANGES_REQUESTED") === prog.scripts.changesRequested && prog.scripts.changesRequested === 1, `${decided("CHANGES_REQUESTED")} / ${prog.scripts.changesRequested}`);
      c.ok(`${who}: released scripts — shared on the portal = monthProgress's released (3)`,
        onMonth.filter((t) => t.script?.shared).length === prog.scripts.releasedAwaitingClient + prog.scripts.clientApproved + prog.scripts.changesRequested && onMonth.filter((t) => t.script?.shared).length === 3,
        `${onMonth.filter((t) => t.script?.shared).length} / ${prog.scripts.releasedAwaitingClient}+${prog.scripts.clientApproved}+${prog.scripts.changesRequested}`);
      c.ok(`${who}: sessions — the schedule card = monthProgress = overview`,
        sched!.sessionsRequired === prog.sessions.required && sched!.sessionsMissing === prog.sessions.missing && row!.session.required === prog.sessions.required && row!.session.missing === prog.sessions.missing,
        `${sched!.sessionsRequired}-${sched!.sessionsMissing} / ${prog.sessions.required}-${prog.sessions.missing} / ${row!.session.required}-${row!.session.missing}`);
      c.ok(`${who}: delivered — library rows = programCountsByMonth = monthProgress = overview`,
        libDelivered(s.monthKey) === counts.get(s.monthKey)!.delivered && counts.get(s.monthKey)!.delivered === prog.production.delivered && row!.production.delivered === prog.production.delivered,
        `${libDelivered(s.monthKey)} / ${counts.get(s.monthKey)!.delivered} / ${prog.production.delivered} / ${row!.production.delivered}`);
      c.ok(`${who}: last month's deliveries agree too`, libDelivered(s.lastMonthKey) === counts.get(s.lastMonthKey)!.delivered, `${libDelivered(s.lastMonthKey)} / ${counts.get(s.lastMonthKey)!.delivered}`);
      c.ok(`${who}: planning — one interview still open (D), the portal and the overview agree`, planning!.interviewsOpen === 1 && !planning!.answersSubmitted, `open ${planning!.interviewsOpen}, submitted ${planning!.answersSubmitted}, overview outstanding ${row!.planning.answersOutstanding}`);
      const ivC = await portal.portalInterview(pair, s.interviews.C);
      const ivD = await portal.portalInterview(pair, s.interviews.D);
      const cScript = onMonth.find((t) => t.id === s.topics.C)?.script;
      c.ok(`${who}: C's interview says "preparing" — its script is drafted and not shared`, ivC?.script.stage === "preparing" && !!cScript && !cScript.shared, `${ivC?.script.stage} / shared ${cScript?.shared}`);
      c.ok(`${who}: D's interview says "none" — no script exists`, ivD?.script.stage === "none" && !onMonth.find((t) => t.id === s.topics.D)?.script, `${ivD?.script.stage}`);
    }
  }

  // =========================================================================
  c.head("7 · nothing left the machine");
  // =========================================================================
  c.ok("every outbound attempt was stopped at the fence", fence.blocked.every((u) => !/^https?:\/\/(127\.|localhost)/.test(u)), `${fence.blocked.length} blocked`);
  c.ok("no message was queued anywhere", (await prisma.outboxMessage.count()) === 0);
  c.ok("the database was this drill's", (process.env.DATABASE_URL ?? "").startsWith(`postgresql://postgres:postgres@127.0.0.1:${PORT}/`));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
