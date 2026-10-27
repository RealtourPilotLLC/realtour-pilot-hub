import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Clapperboard, MessageSquare } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { prisma } from "@/lib/prisma";
import { getTeam } from "@/lib/queries";
import { redactMoney } from "@/lib/hubTools";
import { Section } from "@/components/ui/Section";
import { ProjectMessages } from "@/components/project/ProjectMessages";
import { getShoot, photographerMemberId, photographerOwnsShoot, type ShootView } from "@/lib/shoot";
import { getClientFeedback, getPhotographerFeedback } from "@/lib/review";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canSeeMoney, homeFor } from "@/lib/auth/access";
import { etDateTime, etDayStartUtc, etDaysAgo } from "@/lib/datetime";
import { SHOOT_STATUS_META, type ShootStatusKind } from "@/lib/statusTexts";
import { ShootScreen } from "@/components/shoot/ShootScreen";
import { ShootPayCard, ShootPayCardSkeleton } from "@/components/shoot/ShootPayCard";
import { ShootMapCard, ShootMapCardSkeleton } from "@/components/shoot/ShootMapCard";
import { ShootFeedback } from "@/components/shoot/ShootFeedback";
import { ClientPraiseCard } from "@/components/shoot/ClientPraiseCard";
import { ListingMedia, ListingMediaSkeleton } from "@/components/project/ListingMedia";
import { BriefReadCard } from "@/components/shoot/BriefReadCard";
import { assetRegistry, type AssetRow } from "@/lib/clientAssets";
import { shootBriefLines, briefSnapshot, briefDigest, briefChanges, parseBriefSnapshot } from "@/lib/shootBriefRead";
import { stripMoneySentences } from "@/lib/text";
import { BriefReadOnly } from "@/components/brief/BriefReadOnly";
import type { MonthBriefView } from "@/lib/monthBriefCore";
import { ScriptView } from "@/components/script/ScriptView";
import { stripScriptDashes } from "@/lib/contentPolicy/scriptFormat";
import { ScriptCardTools, ShootScriptsBar } from "@/components/shoot/ShootScriptTools";

export const dynamic = "force-dynamic";

export default async function ShootDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ as?: string }>;
}) {
  const { id } = await params;
  const { as } = await searchParams;

  // The middleware deliberately leaves /shoot/<id> ungated (Kyle taps these
  // links straight off Schedule), so this page is the ONLY gate on it — and the
  // screen carries the assigned photographer's pay for the job plus the client's
  // name, phone, email and address. Guard first, read after.
  const user = await getCurrentUser();
  // Fail CLOSED on a null user under enforcement (same shape as /shoot and
  // /shoot/feedback): a disabled account's stale JWT still passes the
  // middleware, and null falls through the role checks below as "owner-ish" —
  // i.e. any shoot, with someone else's pay on it.
  if (!user && authEnforced()) redirect(`/login?next=/shoot/${id}`);
  // A photographer can only open their OWN assigned shoots (by project assignment
  // or an appointment assignee). Owner / admin (and the open, pre-cutover app)
  // can open any.
  let viewerMemberId: string | null = null;
  if (user?.role === "PHOTOGRAPHER") {
    viewerMemberId = await photographerMemberId(user);
    if (!viewerMemberId || !(await photographerOwnsShoot(id, viewerMemberId))) redirect("/shoot");
  } else if (user && user.role !== "OWNER" && user.role !== "ADMIN" && user.role !== "CREATIVE_MANAGER") {
    // Everyone else — an EDITOR above all — is bounced home (audit Sep 2: an
    // editor could open any /shoot/<id> and read the photographer's pay for
    // that job). The video lane's own screen is /edit/<id>; nothing links an
    // editor here, and the mentions router already sends them to /edit.
    redirect(homeFor(user.role));
  }

  // Oct 20 2026 (audit C5): the visit this viewer is on, a return visit's own
  // appointment rather than always the first. The same member the brief's "I
  // read this" check uses below, so both read the same brief.
  const visitMemberId = viewerMemberId ?? (user && !user.impersonating ? await photographerMemberId(user).catch(() => null) : null);
  const view = await getShoot(id, { viewerMemberId: visitMemberId });
  if (!view) notFound();
  // Whose pay/route to show: a photographer viewer always sees THEIR OWN numbers
  // (a second shooter on someone else's project must never see the primary's
  // pay); owner/admin (and ?as= previews) see the assigned photographer's.
  const payMemberId = viewerMemberId ?? view.photographer?.id ?? null;

  // Capture feedback (review-room PHOTOGRAPHER lane, scoped to this member).
  // The reel script renders inside ShootScreen (ShootView carries the fields),
  // and the old satellite glimpse is gone — the property look now lives on the
  // My Shoots list as Street View → first Aryeo photo.
  // Only the photographer the feedback is addressed to can reply / mark fixed;
  // owner-admin previews (including "view as") are read-only here, matching
  // the server-side authz in reviewActions.
  const feedbackReadOnly = !(user?.role === "PHOTOGRAPHER" && !user.impersonating);
  // Read receipt: the real photographer opening their own shoot marks the
  // feedback SEEN (before the load below, so the receipts they see are fresh).
  // Previews never stamp — Jordan looking isn't Harrison reading.
  // Capture feedback + client praise for the same pay-scoped member. Praise is
  // creative-safe by construction (getClientFeedback: POSITIVE/NEUTRAL only,
  // money-scrubbed) — negative client feedback never reaches this page.
  const loadFeedback = async (): Promise<[Awaited<ReturnType<typeof getPhotographerFeedback>>, Awaited<ReturnType<typeof getClientFeedback>>]> => {
    if (!payMemberId) return [[], []];
    if (!feedbackReadOnly) {
      const { markFeedbackSeen } = await import("@/lib/review");
      await markFeedbackSeen(payMemberId, id);
    }
    return Promise.all([getPhotographerFeedback(id, payMemberId), getClientFeedback(id, payMemberId)]);
  };

  // THE MONEY RULE, on the one screen that carries a person's earnings: a pay
  // card is your OWN pay, or it isn't shown. Jordan, Sep 2 2026 — "Kyle should
  // not have access to any money related info" (canSeeMoney, src/lib/auth/access.ts)
  // — and Kyle taps /shoot/<id> straight off Schedule, where this card was
  // handing him the assigned photographer's earnings for the job. An admin who
  // also shoots (James) keeps the card on HIS OWN shoots; the owner keeps it
  // everywhere, ?as= photographer previews included. The route/map card below is
  // unaffected — miles are ops, not money.
  const ownPay = payMemberId != null && payMemberId === (viewerMemberId ?? user?.teamMemberId ?? null);
  // Oct 20 2026 (audit G): and never for a viewer with no pay to see
  // (settings.payHiddenFor: since Oct 27 2026 that is only a login with no pay
  // structure; Harrison and James see the card on their own shoots again). The
  // card checked this itself, but only after its skeleton had painted.
  const { payHiddenFor } = await import("@/lib/settings");
  const showPay = payMemberId != null && (ownPay || (user ? canSeeMoney(user.role) : !authEnforced())) && !(await payHiddenFor(user));

  // Pay (this viewer's earnings for this shoot) streams in via Suspense so the
  // screen paints immediately instead of blocking on mileage.
  const pay = showPay ? (
    <Suspense fallback={<ShootPayCardSkeleton />}>
      <ShootPayCard projectId={id} memberId={payMemberId!} />
    </Suspense>
  ) : null;

  const startISO = view.appointment?.startISO ?? view.project.shootDateISO;
  const whenText = startISO ? etDateTime(startISO) : "";
  let timing: "today" | "upcoming" | "past" | null = null;
  if (startISO) {
    const d = etDaysAgo(new Date(startISO)); // + past, - future, 0 today
    timing = d === 0 ? "today" : d < 0 ? "upcoming" : "past";
  }

  const media = view.project.aryeoListingId ? (
    <Suspense fallback={<ListingMediaSkeleton />}>
      <ListingMedia listingId={view.project.aryeoListingId} title={view.project.title} projectId={view.project.id} />
    </Suspense>
  ) : null;

  // The receipt is scoped to the real photographer. Owner previews and other
  // staff may inspect this brief but cannot make it look read by the shooter.
  // WHOEVER IS SHOOTING IT marks it read (Oct 5): the photographer, or James
  // on his ADMIN login when the shoot is his — the same assignment test the
  // action applies. Previews and office readers can look, not acknowledge.
  const shooterId = visitMemberId;
  const chatMoney = user ? canSeeMoney(user.role) : !authEnforced();
  // ONE ROUND OF INDEPENDENT READS (audit C16, Oct 20 2026): the feedback, the
  // brief's assets, the month brief, the brief receipt, the job chat and the
  // status texts already sent today used to load one after another.
  const [[feedback, praise], assetsRead, monthBrief, briefReceipt, chatTeam, chatMsgs, sentStatusKinds] = await Promise.all([
    loadFeedback(),
    view.session || view.outputBriefs.length
      ? assetRegistry(view.client.id, { links: false }).then((assets) => ({ assets, failed: false }), () => ({ assets: [] as AssetRow[], failed: true }))
      : Promise.resolve({ assets: [] as AssetRow[], failed: false }),
    // Oct 8 2026: the client's own brief for this job's month (client-planned
    // months above all) — the same door the editor's brief links through.
    view.project.contentSession
      ? import("@/lib/monthBrief").then(async (m) => { const b = await m.briefForProject(id); return b ? { view: await m.briefView(b, null), clientPlanned: b.clientPlanned } : null; }).catch(() => null)
      : Promise.resolve(null),
    (async () => {
      const can = !!user && !user.impersonating && !!shooterId &&
        (viewerMemberId != null || (await photographerOwnsShoot(id, shooterId).catch(() => false)));
      if (!can || !user) return { can, last: null as { snapshotJson: string; readAt: Date } | null, failed: false };
      try {
        const last = await prisma.shootBriefRead.findFirst({ where: { projectId: id, readerUserId: user.id }, orderBy: { readAt: "desc" }, select: { snapshotJson: true, readAt: true } });
        return { can, last, failed: false };
      } catch {
        return { can, last: null, failed: true };
      }
    })(),
    getTeam().catch(() => []),
    // The newest 50 (audit C16: a long thread loaded whole), shown oldest first.
    prisma.projectMessage
      .findMany({
        where: { projectId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { replyTo: { select: { authorName: true, body: true } } },
      })
      .then((rows) => rows.reverse())
      .catch(() => []),
    sentStatusToday(id),
  ]);
  const briefAssets = assetsRead.assets;
  const briefUnavailable = assetsRead.failed || briefReceipt.failed;
  const canReadBrief = briefReceipt.can;
  const lastBriefRead = briefReceipt.last;
  const briefLines = shootBriefLines(view, briefAssets);
  const briefDigestNow = briefDigest(briefSnapshot(briefLines));
  const briefDelta = lastBriefRead ? briefChanges(parseBriefSnapshot(lastBriefRead.snapshotJson), briefLines) : [];
  // Oct 14 2026: editing a script and texting the PDF are real acts; a preview ("view as") only reads and downloads.
  const scriptsEditable = user ? !user.impersonating : !authEnforced();

  // Day's shoots + driving route — streams in (one OSRM call) so the screen
  // paints first. ShootScreen owns the page layout; this top slot carries
  // client praise, then review feedback (when either exists the shoot is past
  // and the feedback is why they're here — the bell deep-links to this page),
  // then the route. Praise leads: the win lands before the punch list.
  const map = (
    <>
      {praise.length > 0 && <ClientPraiseCard items={praise} />}
      {feedback.length > 0 && (
        <ShootFeedback notes={feedback} readOnly={feedbackReadOnly} photographerName={view.photographer?.name ?? null} projectId={id} />
      )}
      <Suspense fallback={<ShootMapCardSkeleton />}>
        <ShootMapCard projectId={id} memberId={payMemberId} />
      </Suspense>
      {/* §6.8 / A28 (Sep 25): what this session is FOR, straight under the
          route — the topics, the words the client was shown and the direction
          written with them, and any video with a brief of its own. The same
          readers the editor's page and printed brief use. */}
      <SessionBriefCard session={view.session} outputs={view.outputBriefs} assets={briefAssets} clientBrief={monthBrief} tools={{ projectId: id, canEdit: scriptsEditable, canText: scriptsEditable && !!view.client.phoneE164, agentFirst: view.client.firstName || "the agent" }} />
    </>
  );
  // "I read this brief" sits UNDER what it is about (Oct 5): ShootScreen
  // places it after the access brief, the checklist, the scripts and the
  // client's own words, so the button is pressed after the reading.
  const briefRead = <BriefReadCard projectId={id} digest={briefDigestNow} readAtISO={lastBriefRead?.readAt.toISOString() ?? null} changes={briefDelta} canAcknowledge={canReadBrief} unavailable={briefUnavailable} />;

  // THE JOB'S TEAM CHAT, on the photographer's screen (Kyle call, Sep 16).
  // Tagging a photographer already sent them here — postProjectMessage's
  // href for a PHOTOGRAPHER is /shoot/<id> — but there was no thread on this
  // page to land on: they could read the tag only inside the task summary and
  // could not answer it at all. Now they can, on their OWN shoots, which is
  // the same gate this page already enforced at the top (a photographer who
  // doesn't own the shoot never reaches this line). Compact, under the editor
  // notes: it is a wrap-up conversation, not the reason they are on site.
  // MONEY: this is a field screen, so every body goes through the hub's
  // redactor unless the reader is the owner — the sentence stays, the figure
  // goes (the same rule the job page applies to its activity feed).
  const chatScrub = (t: string) => (chatMoney ? t : redactMoney(t));
  // A preview ("view as") reads; so does an owner/admin who is only looking in
  // on someone else's field screen — no, they post too: this is the one place
  // the office and the shooter share on a shoot day. Only impersonation reads.
  const chat = (
    <Section icon={MessageSquare} title="Job chat">
      <ProjectMessages
        projectId={id}
        compact
        readOnly={!!user?.impersonating}
        team={chatTeam.map((m) => ({ id: m.id, name: m.name, avatarColor: m.avatarColor }))}
        messages={chatMsgs.map((m) => ({
          id: m.id,
          authorId: m.authorId,
          authorName: m.authorName,
          body: chatScrub(m.body),
          createdAt: m.createdAt.toISOString(),
          ago: formatDistanceToNow(m.createdAt, { addSuffix: true }),
          replyTo: m.replyTo ? { authorName: m.replyTo.authorName, body: chatScrub(m.replyTo.body) } : null,
        }))}
      />
    </Section>
  );

  // Owner/admin viewing as a photographer: "back" returns to that photographer's
  // scoped list. Photographers never carry an ?as= back link (fail-closed).
  const backHref = user?.role !== "PHOTOGRAPHER" && as ? `/shoot?as=${as}` : "/shoot";

  return <ShootScreen view={view} pay={pay} map={map} briefRead={briefRead} whenText={whenText} timing={timing} media={media} chat={chat} backHref={backHref} sentStatusKinds={sentStatusKinds} />;
}

/**
 * The status texts already sent to the client today, read off the timeline
 * lines sendShootStatusText writes (audit C12, Oct 20 2026): the ticks used
 * to live only in the screen, so after a reload "On my way" looked unsent and
 * could go twice. A read that fails shows nothing ticked, as before.
 */
async function sentStatusToday(projectId: string): Promise<ShootStatusKind[]> {
  const kinds = Object.keys(SHOOT_STATUS_META) as ShootStatusKind[];
  const rows = await prisma.activity
    .findMany({
      where: { projectId, type: "SYSTEM", createdAt: { gte: etDayStartUtc() }, OR: kinds.map((k) => ({ body: { startsWith: `${SHOOT_STATUS_META[k].sent} — texted` } })) },
      select: { body: true },
      take: 20,
    })
    .catch(() => []);
  return kinds.filter((k) => rows.some((r) => r.body.startsWith(`${SHOOT_STATUS_META[k].sent} — texted`)));
}

/** One topic of a filming session, read on a phone mid-shoot (Oct 14 2026, Jordan: "make sure the text is formatted nicely and easily readable"). */
type ScriptTools = { projectId: string; canEdit: boolean; canText: boolean; agentFirst: string };
function SessionTopicCard({ t, n, tools }: { t: NonNullable<ShootView["session"]>["topics"][number]; n: number; tools: ScriptTools }) {
  const title = stripScriptDashes(t.script?.title || t.title, { title: true });
  const clean = (x: string | null | undefined) => (x ? stripScriptDashes(x) : x);
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3 sm:p-4">
      <div className="text-lg font-semibold leading-snug text-balance">{n}. {title}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        {t.script && (
          <span className={`rounded-full px-2 py-0.5 font-medium ${t.script.clientApproved ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>
            {t.script.clientApproved ? "Client approved" : "Not approved by the client yet"}
          </span>
        )}
        {t.script && <span className="text-muted">Script v{t.script.versionNo}</span>}
        {/* Oct 22 2026: a skit is filmed differently, so the card says which it is. */}
        {t.script?.format && <span className={`rounded-full px-2 py-0.5 font-medium ${t.script.format === "SKIT" ? "bg-brand/15 text-brand" : "bg-surface-2 text-muted"}`}>{t.script.format === "SKIT" ? "Skit" : "Talking to camera"}</span>}
        {t.overflow && <span className="rounded-full bg-warning/10 px-2 py-0.5 font-medium text-warning">Extra, if there is time</span>}
      </div>
      {t.script ? (
        <>
          {!t.script.clientApproved && (
            <p className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-sm leading-relaxed text-foreground/90">Film it as written. The client can still ask for changes.</p>
          )}
          {t.script.format === "SKIT" && (
            <p className="mt-2 rounded-lg bg-brand/10 px-3 py-2 text-sm leading-relaxed text-foreground/90">A skit: an acted scene, not a talk to camera. Film it line by line, follow the directions in brackets, and leave room for reactions. Only the people named in the script are on camera.</p>
          )}
          {t.script.text ? (
            <div className="mt-1 max-w-[65ch]"><ScriptView body={clean(t.script.text) ?? ""} size="lg" audience="staff" showMissingPillar={false} fileTitle={title} textDownload={!t.script.scriptId} /></div>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-sm text-muted">{t.noScript}</p>
      )}
      {t.script?.scriptId && t.script.versionId && (
        <ScriptCardTools projectId={tools.projectId} scriptId={t.script.scriptId} versionId={t.script.versionId} parts={t.script.parts ?? null} canEdit={tools.canEdit} />
      )}
      {t.script?.direction && (t.script.direction.filmingNotes || t.script.direction.creativeDirection || t.script.direction.productionNotes) && (
        <div className="mt-3 space-y-2 rounded-lg border border-border bg-surface/60 p-3 text-sm leading-relaxed text-foreground/90">
          {t.script.direction.filmingNotes && <div><div className="text-[11px] font-bold uppercase tracking-wider text-brand">Filming notes</div><p className="mt-0.5">{clean(t.script.direction.filmingNotes)}</p></div>}
          {t.script.direction.creativeDirection && <div><div className="text-[11px] font-bold uppercase tracking-wider text-brand">Direction</div><p className="mt-0.5">{clean(t.script.direction.creativeDirection)}</p></div>}
          {t.script.direction.productionNotes && <div><div className="text-[11px] font-bold uppercase tracking-wider text-brand">Production</div><p className="mt-0.5">{clean(t.script.direction.productionNotes)}</p></div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// THIS SESSION'S VIDEOS (§6.8 / §7.5 / A28, Sep 25 2026). Server-rendered and
// read-only: the photographer directs from it, and the office changes it where
// it lives (the scripts in the content workspace, a video's brief on its edit
// page). Everything in it arrived money-scrubbed from lib/shoot.
// ---------------------------------------------------------------------------
function SessionBriefCard({ session, outputs, assets, clientBrief, tools }: { session: ShootView["session"]; outputs: ShootView["outputBriefs"]; assets: AssetRow[]; clientBrief?: { view: MonthBriefView | null; clientPlanned: boolean } | null; tools: ScriptTools }) {
  if (!session && outputs.length === 0 && !clientBrief) return null;
  const clientPlanned = !!clientBrief?.clientPlanned;
  const shoot = session?.shoot ?? null;
  const live = session?.topics.filter((t) => !t.filmedElsewhere) ?? [];
  // Oct 14 2026: a month filmed over several shoots shows THIS shoot's share
  // first; the rest wait, collapsed, under the shoot they are planned for.
  const toFilm = live.filter((t) => !shoot || !t.plannedShoot || t.plannedShoot.n === shoot.n);
  const otherShoot = live.filter((t) => shoot && t.plannedShoot && t.plannedShoot.n !== shoot.n);
  const elsewhere = session?.topics.filter((t) => t.filmedElsewhere) ?? [];
  const brand = session?.brand ?? null;
  const hasBrand = !!brand && (!!brand.fontNames || brand.files.length > 0 || !!brand.music || brand.productionDefaults.length > 0 || brand.acceptedPreferences.length > 0);
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) : "the other shoot");
  return (
    <Section
      icon={Clapperboard}
      title={session ? "This session's videos" : "Each video's brief"}
      count={session ? `${toFilm.length} topic${toFilm.length === 1 ? "" : "s"}${shoot ? ` · shoot ${shoot.n} of ${shoot.of}` : ""}` : undefined}
      bodyClassName="space-y-3"
    >
      {clientBrief && <BriefReadOnly brief={clientBrief.view} clientPlanned={clientPlanned} monthName={session?.monthKey ? new Date(Date.UTC(Number(session.monthKey.slice(0, 4)), Number(session.monthKey.slice(5, 7)) - 1, 15)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }) : "this month"} />}
      {session && toFilm.length === 0 && !clientPlanned && (
        <p className="text-sm text-muted">No topics are chosen for this session yet. Ask the office before you start.</p>
      )}
      {shoot && toFilm.length > 0 && (
        <p className="text-sm text-muted">This month is filmed over {shoot.of} shoots. Film these {toFilm.length} today; the rest are below for {shoot.of === 2 ? "the other shoot" : "the other shoots"}.</p>
      )}
      {toFilm.some((t) => t.script) && <ShootScriptsBar projectId={tools.projectId} agentFirst={tools.agentFirst} count={toFilm.filter((t) => t.script).length} canText={tools.canText} />}
      {toFilm.map((t, i) => <SessionTopicCard key={t.topicId} t={t} n={i + 1} tools={tools} />)}
      {otherShoot.length > 0 && (
        <details className="group/other rounded-xl border border-dashed border-border p-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium text-foreground/90">
            <span aria-hidden="true" className="inline-block text-muted transition-transform group-open/other:rotate-90">›</span>
            <span>Planned for {day(otherShoot[0].plannedShoot?.whenISO ?? null)} ({otherShoot.length} topic{otherShoot.length === 1 ? "" : "s"})</span>
          </summary>
          <p className="mt-1 text-xs text-muted">Only film these today if the office asks you to.</p>
          <div className="mt-3 space-y-3">{otherShoot.map((t, i) => <SessionTopicCard key={t.topicId} t={t} n={toFilm.length + i + 1} tools={tools} />)}</div>
        </details>
      )}
      {elsewhere.length > 0 && (
        <p className="text-xs text-muted">Already filmed at the other session: {elsewhere.map((t) => t.title).join(", ")}.</p>
      )}
      {hasBrand && brand && (
        <div className="rounded-xl border border-brand/25 bg-brand-soft/40 p-3 text-xs leading-relaxed">
          <div className="mb-1 font-semibold text-brand">Their brand</div>
          {brand.fontNames && <p><span className="text-muted">Fonts: </span>{brand.fontNames}</p>}
          {brand.files.length > 0 && <p><span className="text-muted">On file: </span>{brand.files.map((f) => `${f.typeWord} (${f.name}, v${f.versionNo})`).join(", ")}</p>}
          {brand.music && <p><span className="text-muted">Music: </span>{brand.music}</p>}
          {brand.productionDefaults.map((d) => <p key={d.name}><span className="text-muted">{d.name}: </span>{d.text}</p>)}
          {brand.acceptedPreferences.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {brand.acceptedPreferences.map((x, i) => <li key={i}>{x}</li>)}
            </ul>
          )}
        </div>
      )}
      {assets.filter((a) => ["PRONUNCIATION", "APPROVED_PHOTO", "EXAMPLE_VIDEO"].includes(a.type) && a.active && !a.active.cleared).length > 0 && (
        <div className="rounded-xl border border-border bg-surface-2/40 p-3 text-xs leading-relaxed">
          <div className="mb-1 font-semibold">Pronunciation and references</div>
          {assets.filter((a) => ["PRONUNCIATION", "APPROVED_PHOTO", "EXAMPLE_VIDEO"].includes(a.type) && a.active && !a.active.cleared).map((a) => (
            <p key={a.id} className="whitespace-pre-wrap"><span className="text-muted">{a.type === "PRONUNCIATION" ? "Pronunciation" : a.type === "EXAMPLE_VIDEO" ? "Video reference" : "Approved photo"}: </span>{stripMoneySentences(a.name)} · v{a.active?.versionNo}{a.active?.valueText ? ` — ${stripMoneySentences(a.active.valueText)}` : a.active?.fileName ? ` — ${stripMoneySentences(a.active.fileName)} on file` : ""}</p>
          ))}
        </div>
      )}
      {outputs.map((o) => (
        <div key={o.outputId} className="rounded-xl border border-border bg-surface-2/40 p-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold">{o.label}</span>
            {o.format !== o.label && <span className="text-[11px] text-muted">{o.format}</span>}
          </div>
          <p className="text-[11px] text-muted-2">{o.versionLabel}</p>
          <p className="mt-1 text-xs"><span className="text-muted">Chosen logo / branding card: </span>{o.brandAsset ? `${o.brandAsset.name}${o.brandAsset.versionNo ? ` v${o.brandAsset.versionNo}` : ""}${o.brandAsset.state !== "current" ? " · no longer current; ask Kyle" : ""}` : o.brandChoice === "none" ? "intentionally none for this video" : "not recorded for this video"}</p>
          <dl className="mt-1 space-y-1 text-xs leading-relaxed">
            {o.sections.map((x) => (
              <div key={x.label}>
                <dt className="font-medium text-muted">{x.label}</dt>
                <dd className="whitespace-pre-wrap">{x.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </Section>
  );
}
