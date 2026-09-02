import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Mail, Phone, Building2, IdCard, Package, DollarSign,
  Activity as ActivityIcon, Star, ArrowRight, Camera, Users, Sparkles,
} from "lucide-react";
import { BackLink } from "@/components/ui/BackLink";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, ink } from "@/components/ui/Badge";
import { SegmentBadge } from "@/components/clients/SegmentBadge";
import { SocialBadge } from "@/components/clients/SocialBadge";
import { ClientWorkspace } from "@/components/clients/ClientWorkspace";
import { AgentProfile } from "@/components/clients/AgentProfile";
import { ClientChat } from "@/components/clients/ClientChat";
import { ClientEmails } from "@/components/clients/ClientEmails";
import { ClientTodos } from "@/components/clients/ClientTodos";
import { ClientProfileCard } from "@/components/clients/ClientProfileCard";
import { ClientNotificationPrefs } from "@/components/clients/ClientNotificationPrefs";
import { parseClientProfile } from "@/lib/clientProfile";
import { ShowMore } from "@/components/ui/ShowMore";
import { dropboxWebUrl } from "@/lib/dropboxFolders";
import { notesHtmlToText } from "@/lib/integrations/aryeo";
import { getClientDetail } from "@/lib/queries";
import { autoTextRules } from "@/lib/settings";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canSeeMoney } from "@/lib/auth/access";
import { redactMoney } from "@/lib/hubTools";
import { stageMeta } from "@/lib/pipeline";
import { formatMoney, stripHtml } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { etDateYear, etMonthDay, etDateTime } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// What an admin reads in place of a timeline row that was ENTIRELY about money.
// The row keeps its slot and timestamp: a line that silently disappeared would
// read as "nothing happened here". Same wording as the job page.
const HELD_BACK = "Money detail — owner only.";

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getClientDetail(id);
  if (!data) notFound();
  const { client, timeline, totalSpend } = data;

  // Orders count + lifetime spend exclude cancelled, to match the segment chip.
  const orderCount = client.projects.filter((p) => p.status !== "CANCELLED").length;

  // Best-effort "last thing the client said" for the AI draft hint — exclude our
  // own outbound log lines ("Text sent to …", "Delivery text sent …") so we never
  // draft a reply to ourselves.
  const lastInbound =
    timeline.find(
      (t) =>
        t.kind === "activity" &&
        /text:|email|message|said|wrote|asked|inbound/i.test(t.body) &&
        !/\bsent to\b|sent\.|\breplied\b/i.test(t.body),
    )?.body ?? "";

  const enrollment = await prisma.contentEnrollment.findUnique({ where: { clientId: client.id }, select: { id: true } }).catch(() => null);

  // Who may flip the per-client notification switches. Same shape as the other
  // owner/admin gates on this hub: middleware already keeps creatives off
  // /clients, and getCurrentUser() is null both in local dev (auth off ⇒ owner
  // view) and for a revoked account still holding a valid JWT — so a null only
  // grants edit when enforcement is off. "View as" is read-only, matching
  // requireAdmin(), so the action can't reject a switch the screen let them flip.
  const me = await getCurrentUser().catch(() => null);
  const canEditPrefs = me
    ? (me.realRole === "OWNER" || me.realRole === "ADMIN") && !me.impersonating
    : !authEnforced();

  // Jordan, Sep 2 2026: an admin gets full ops access and NO money. This page
  // led with the client's LIFETIME SPEND in the header and printed the price of
  // every order in the list — the single largest money surface below the Finance
  // hub. canSeeMoney() is the hub's one money rule (src/lib/auth/access.ts):
  // OWNER only. Same `me ?: !authEnforced()` shape as canEditPrefs above — the
  // effective role (so "view as Kyle" previews the money-blind page), and a null
  // viewer only grants when enforcement is off (local dev, Jordan alone).
  const showMoney = me ? canSeeMoney(me.role) : !authEnforced();
  // Free text on this page replays the client's own texts and emails, which is
  // where pricing turns up ("$50 per room"). redactMoney (src/lib/hubTools.ts)
  // is the hub's rule for that: keep the sentence, drop the FIGURE, and drop
  // whole any sentence whose subject is internal money (AR, margin, payroll).
  const scrub = (t: string) => (showMoney ? t : redactMoney(t));

  // The LIVE automation rules, so the notification card states real timings and
  // can say out loud when the global master switch (Settings → Automated texts)
  // is what's actually stopping a text — not a per-client preference.
  const autoRules = await autoTextRules().catch(() => null);

  return (
    <div>
      <div className="border-b border-border px-4 py-4 sm:px-6">
        <BackLink href="/clients" label="All clients" className="mb-3" />
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={client.name} size={56} color="#4f46e5" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{client.name}</h1>
              <SegmentBadge segment={client.segment} title />
              <SocialBadge socialClient={client.socialClient} socialPlan={client.socialPlan} />
              {/* Two-way navigation: the content workspace links here; this
                  links back (audit: the trip was one-way). */}
              {enrollment && (
                <Link href={`/content/${enrollment.id}`} className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand hover:bg-brand/20">
                  Content workspace →
                </Link>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              {client.company && (
                <span className="inline-flex items-center gap-1.5"><Building2 className="size-3.5" /> {client.company}</span>
              )}
              {client.email && (
                <a href={`mailto:${client.email}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                  <Mail className="size-3.5" /> {client.email}
                </a>
              )}
              {client.backupEmail && (
                <a href={`mailto:${client.backupEmail}`} className="inline-flex items-center gap-1.5 text-muted-2 hover:text-foreground" title="Backup email (from a merged duplicate)">
                  <Mail className="size-3.5" /> {client.backupEmail} <span className="text-[10px] uppercase tracking-wide">backup</span>
                </a>
              )}
              {client.phone && (
                <a href={`tel:${client.phone}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                  <Phone className="size-3.5" /> {client.phone}
                </a>
              )}
              {client.licenseNumber && (
                <span className="inline-flex items-center gap-1.5"><IdCard className="size-3.5" /> {client.licenseNumber}</span>
              )}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href={`/assistant?q=${encodeURIComponent(`Catch me up on ${client.name}: recent messages, open work, and anything outstanding.`)}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-soft/40 px-3 py-2 text-sm font-medium text-brand hover:bg-brand-soft"
            >
              <Sparkles className="size-4" /> Ask the Hub
            </Link>
            {/* Orders is the ops number — how much work this client gives us.
                Lifetime spend is money and is the owner's alone. It is dropped,
                not blanked: there is no figure here to misread as zero. */}
            <Stat icon={<Package className="size-4" />} label="Orders" value={String(orderCount)} />
            {showMoney && (
              <Stat icon={<DollarSign className="size-4" />} label="Lifetime" value={formatMoney(totalSpend)} />
            )}
          </div>
        </div>
        {client.parent && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-brand-soft px-3 py-2 text-xs text-brand">
            <Users className="size-3.5 shrink-0" />
            <span>
              Assistant on{" "}
              <Link href={`/clients/${client.parent.id}`} className="font-semibold underline">{client.parent.name}</Link>
              ’s team{client.aryeoTeamName ? ` (${client.aryeoTeamName})` : ""} — their texts &amp; emails route to {client.parent.name}’s projects.
            </span>
          </div>
        )}
        {!client.parent && client.teamMembers.length > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            <Users className="size-3.5 shrink-0" />
            <span>Team{client.aryeoTeamName ? ` (${client.aryeoTeamName})` : ""}: {client.teamMembers.map((m) => m.name).join(", ")} — their comms fold into this account.</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* MAIN: orders + activity */}
        <div className="space-y-6">
          {/* Working profile — who this client is to work with (creative-safe) */}
          <ClientProfileCard
            clientId={client.id}
            profile={parseClientProfile(client.profileJson)}
            updatedAt={client.profileUpdatedAt ? etDateTime(client.profileUpdatedAt) : null}
          />

          {/* Orders */}
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Package className="size-4 text-muted" /> Orders &amp; projects</h2>
            <div className="space-y-2">
              {client.projects.length === 0 && <p className="text-sm text-muted">No orders yet.</p>}
              <ShowMore initial={5}>
              {client.projects.map((p) => {
                const stage = stageMeta(p.status);
                return (
                  <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center gap-3 rounded-xl border bg-surface p-3 hover:bg-surface-2">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: stage.soft, color: ink(stage.color) }}>
                      <Camera className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{p.title}</span>
                        <Badge color={stage.color} soft={stage.soft}>{stage.short}</Badge>
                      </div>
                      <div className="truncate text-xs text-muted">
                        {p.orderedAt ? etDateYear(p.orderedAt) : ""}
                        {p.shootDate ? ` · shoot ${etMonthDay(p.shootDate)}` : ""}
                        {` · ${p.deliverables.length} item${p.deliverables.length === 1 ? "" : "s"}`}
                        {/* Item COUNT and paid/unpaid stay — both are ops facts
                            and neither is an amount. The per-order price is the
                            money and stops at the owner. */}
                        {showMoney && p.price ? ` · ${formatMoney(p.price)}` : ""}
                        {p.paymentStatus ? ` · ${p.paymentStatus.toLowerCase().replace(/_/g, " ")}` : ""}
                      </div>
                    </div>
                    <ArrowRight className="size-4 shrink-0 text-muted" />
                  </Link>
                );
              })}
              </ShowMore>
            </div>
          </section>

          {/* Live OpenPhone conversation — full texting chat */}
          {client.phone && <ClientChat clientId={client.id} clientName={client.name} />}

          {/* Live Gmail conversation (read-only) for context */}
          {(client.email || client.backupEmail) && <ClientEmails clientId={client.id} />}

          {/* Activity timeline */}
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><ActivityIcon className="size-4 text-muted" /> Recent activity</h2>
            <div className="rounded-2xl border bg-surface">
              {timeline.length === 0 && <p className="p-4 text-sm text-muted">No activity yet.</p>}
              <ShowMore initial={5} className="border-t border-border">
              {timeline.slice(0, 60).map((t) => {
                // The timeline is the client's own conversation played back —
                // the one place per-product pricing reaches this page now the
                // header and the order rows are gated. A row the scrub empties
                // keeps its slot and timestamp rather than vanishing.
                const body = scrub(stripHtml(t.body));
                return (
                <div key={t.id} className="flex gap-3 border-b border-border px-4 py-3 last:border-0">
                  <span className="mt-1">
                    {t.kind === "feedback" ? <Star className="size-4 text-warning" /> : <ActivityIcon className="size-4 text-muted-2" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    {t.kind === "feedback" && (
                      <div className="mb-0.5 text-xs font-medium text-warning">
                        Feedback{t.rating ? ` · ${t.rating}/5` : ""}{t.sentiment ? ` · ${t.sentiment.toLowerCase()}` : ""}
                      </div>
                    )}
                    <p className={body ? "text-sm text-foreground/90" : "text-sm italic text-muted"}>
                      {body || HELD_BACK}
                    </p>
                    <div className="mt-0.5 text-[11px] text-muted-2">
                      {formatDistanceToNow(t.at, { addSuffix: true })}
                      {t.projectTitle && (
                        <> · <Link href={`/projects/${t.projectId}`} className="text-brand hover:underline">{t.projectTitle}</Link></>
                      )}
                    </div>
                  </div>
                </div>
                );
              })}
              </ShowMore>
            </div>
          </section>
        </div>

        {/* SIDEBAR: agent profile + workspace + open to-dos */}
        <div className="space-y-6">
          <AgentProfile
            clientId={client.id}
            clientPreferences={client.clientPreferences ?? ""}
            brandColors={client.brandColors ?? ""}
            brandAssetsPath={client.brandAssetsPath}
            brandAssetsUrl={client.brandAssetsPath ? dropboxWebUrl(client.brandAssetsPath) : null}
          />

          {/* ONE set of customer notes. The column mirrors Aryeo's customer
              notes (rich text over there, plain text in the box here), and the
              card pushes edits straight back — see saveCustomerNotes. */}
          <ClientWorkspace
            clientId={client.id}
            hasPhone={!!client.phone}
            email={client.email}
            lastInbound={lastInbound}
            notes={notesHtmlToText(client.generalNotes)}
            notesSyncedAt={client.notesSyncedAt ? etDateTime(client.notesSyncedAt) : null}
            notesSyncError={client.notesSyncError}
            aryeoLinked={!!client.aryeoCustomerId}
          />

          {/* Per-client notification switches — the exception to Settings →
              Automated texts, for the client who asked us not to text. */}
          <ClientNotificationPrefs
            clientId={client.id}
            clientName={client.name}
            hasPhone={!!client.phone}
            // `!== false`, not a bare read: both columns are NOT NULL with a
            // default of true, so the only way to get anything but a boolean
            // here is a stale Prisma client mid-deploy — and rendering "off"
            // for a client the sweep will happily text is the one lie this
            // card must never tell. Unknown reads as ON, matching the column.
            autoConfirmationText={client.autoConfirmationText !== false}
            autoDeliveryText={client.autoDeliveryText !== false}
            canEdit={canEditPrefs}
            rules={{
              // Settings unreadable (a DB hiccup) ⇒ describe the shipped
              // defaults rather than render blanks; nothing here decides a send.
              globalEnabled: autoRules?.enabled ?? true,
              confirmationEnabled: autoRules?.confirmation.enabled ?? true,
              deliveryEnabled: autoRules?.delivery.enabled ?? true,
              hoursBefore: autoRules?.confirmation.hoursBefore ?? 48,
              windowLabel: sendWindowLabel(autoRules?.sendFromHour ?? 9, autoRules?.sendUntilHour ?? 16),
            }}
          />

          <ClientTodos
            todos={client.smartTasks.map((t) => ({
              id: t.id,
              title: t.title,
              taskType: t.taskType,
              dueAt: t.dueAt ? t.dueAt.toISOString() : null,
              projectId: t.projectId,
            }))}
          />
        </div>
      </div>
    </div>
  );
}

// "9:00 AM – 4:00 PM ET" from the two 24-hour ET numbers the send window is
// stored as. ET everywhere, like every other time on this hub.
function sendWindowLabel(from: number, until: number): string {
  const h12 = (h: number) => {
    const am = h < 12 || h === 24;
    const v = h % 12 === 0 ? 12 : h % 12;
    return `${v}:00 ${am ? "AM" : "PM"}`;
  };
  return `${h12(from)} – ${h12(until)} ET`;
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-surface px-3 py-2 text-center">
      <div className="flex items-center justify-center gap-1 text-muted-2">{icon}</div>
      <div className="mt-0.5 text-sm font-semibold">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-2">{label}</div>
    </div>
  );
}
