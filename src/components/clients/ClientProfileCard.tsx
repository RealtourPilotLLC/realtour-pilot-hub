import { UserRound, Palette, Repeat, ShieldCheck, Ban, Check } from "lucide-react";
import {
  editorView, liveProfileFacts, recentRevisionAsks,
  type ClientProfile, type EditorClientProfile, type ProfileFacts, type RevisionAsk,
} from "@/lib/clientProfile";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { Avatar } from "@/components/ui/Avatar";
import { SegmentBadge } from "@/components/clients/SegmentBadge";
import { ClientProfileCardView } from "@/components/clients/ClientProfileCardView";
import { Bullets, RecentAsks, Stat } from "@/components/clients/profileParts";

// ---------------------------------------------------------------------------
// THE WORKING PROFILE CARD — audience-scoped (Sep 2 2026).
//
// Jordan, on the profile an editor was reading off Mike Ciunci's job: "There is
// too much there… These are all things that are not relevant or necessary for
// the editor to know." He was seeing the office-visit locations, the on-camera
// and wardrobe asks, that faith is part of Mike's brand, that he referred a
// colleague, and his "LFG / My Man" texting voice.
//
// So this entry point is a SERVER component with two forms:
//   · "full"  → the whole profile (it is genuinely how Jordan and Kyle work)
//   · "brief" → the editor's brief below, built from editorView()
// The PAGE picks the form (`variant`), not the viewer's role: /edit/<id> is the
// editor's brief screen, so it asks for "brief" for everyone — Jordan reads it
// as OWNER and wants to see exactly what John and Kim see ("The working
// profile still hasn't changed", Sep 2, round 3: the compact card had been
// gated to the EDITOR role, so the owner kept getting the full one). Without a
// `variant` — /clients/<id> — the role decides, and it fails NARROW when we
// can't prove who is looking. The filter runs here, on the server, so the
// rapport and comms text is never serialized into an editor's browser at all.
//
// Second round, same day, on the editor's card: "I feel like the working
// profile should be a brief summary, with the most important information first
// for the editor… it's too long and too much to sift through." Hence
// EditorProfileCard is a BRIEF — only the editor-safe parts, most important
// first — see it below.
//
// Fourth round (Sep 2, evening), once the brief was the right size: "Working
// Profile should say the agent's name up top, and then the dropdown isn't
// necessary anymore because there isn't a ton of information, so it's fine to
// show it. Also, Revisions should be titled (Past Revision Requests) And then
// if the agent has a profile photo in aryeo that should be shown here too."
// So the brief now opens with the agent's headshot and name, lays everything
// out flat (the "More about this client" fold is gone), and gathers the
// revision picture and the recent asks under one "Past Revision Requests"
// heading.
// ---------------------------------------------------------------------------

export async function ClientProfileCard({
  clientId,
  profile,
  updatedAt,
  variant,
}: {
  clientId: string;
  profile: ClientProfile | null;
  updatedAt: string | null;
  /**
   * Which form the PAGE wants: "brief" is the compact, editor-safe card headed
   * by the agent's name and photo; "full" is the whole profile. Omitted =
   * decide from the signed-in viewer's role (owner/admin full, others brief).
   */
  variant?: "full" | "brief";
}) {
  // The viewer is only consulted when the page left the choice to us. Fail to
  // the NARROW view when we can't prove who's looking — except in local open
  // mode, where there is no session at all and Jordan is the only user. Any
  // non-owner/admin viewer lands on the brief, never the full card.
  const viewer = variant ? null : await getCurrentUser();
  const scope =
    variant ??
    (viewer
      ? viewer.role === "OWNER" || viewer.role === "ADMIN" ? "full" : "brief"
      : authEnforced() ? "brief" : "full");

  // The brief is headed by the agent's name and Aryeo headshot (round 4).
  // Aryeo owns the photo — the nightly customer sync mirrors it onto
  // Client.avatarUrl — and Avatar falls back to initials when there is none.
  // The full card has its own header, so the lookup is skipped for it.
  const [asks, facts, who] = await Promise.all([
    recentRevisionAsks(clientId),
    liveProfileFacts(clientId),
    scope === "brief"
      ? prisma.client.findUnique({ where: { id: clientId }, select: { name: true, avatarUrl: true } })
      : null,
  ]);

  if (scope === "brief") return <EditorProfileCard who={who} profile={editorView(profile)} facts={facts} asks={asks} updatedAt={updatedAt} />;
  return <ClientProfileCardView clientId={clientId} profile={profile} facts={facts} asks={asks} updatedAt={updatedAt} />;
}

// ---------------------------------------------------------------------------
// THE EDITOR'S BRIEF.
//
// Everything on it is editor-safe (editorView() did the audience filtering)
// and all of it shows — Jordan, round 4: "the dropdown isn't necessary anymore
// because there isn't a ton of information, so it's fine to show it." Most
// important first: the editor's summary line, then the standing preferences
// (logos, endcards, music), the hard "never" rules and the advice lines, then
// the brand/style paragraph, the customer notes, the past revision requests,
// and last the live counts and the segment.
//
// When the editing block is empty (72 of 215 clients the day this shipped) the
// top says so in one honest line instead of rendering empty headings.
//
// No regenerate button — rebuilding a profile is admin-only (requireAdmin in
// regenerateClientProfile), so offering an editor the button would only ever
// hand them "You don't have access to do that."
// ---------------------------------------------------------------------------

type BriefLine = { kind: "pref" | "never" | "do"; text: string };

// The lines an editor reads before opening the timeline, in priority order:
// `prefs` are the standing instructions for the finished video, `donts` the
// hard rules, `dos` the advice. editorView() has already done the audience
// filtering, so this only orders them.
function briefLines(e: EditorClientProfile["editing"] | undefined): BriefLine[] {
  return [
    ...(e?.prefs ?? []).map((text) => ({ kind: "pref" as const, text })),
    ...(e?.donts ?? []).map((text) => ({ kind: "never" as const, text })),
    ...(e?.dos ?? []).map((text) => ({ kind: "do" as const, text })),
  ];
}

function BriefList({ lines }: { lines: BriefLine[] }) {
  return (
    <ul className="space-y-1.5">
      {lines.map((l, i) => (
        <li key={i} className="flex gap-2 text-sm leading-relaxed text-foreground/90">
          {l.kind === "pref" && <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand/60" />}
          {l.kind === "never" && (
            <span className="mt-[3px] inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-danger/15 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-danger">
              <Ban className="size-3" /> Never
            </span>
          )}
          {l.kind === "do" && (
            <span className="mt-[3px] inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-success/15 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-success">
              <Check className="size-3" /> Do
            </span>
          )}
          <span>{l.text}</span>
        </li>
      ))}
    </ul>
  );
}

function EditorProfileCard({
  who,
  profile,
  facts,
  asks,
  updatedAt,
}: {
  /** The agent: name for the title, Aryeo headshot when they have one. */
  who: { name: string; avatarUrl: string | null } | null;
  profile: EditorClientProfile | null;
  facts: ProfileFacts;
  asks: RevisionAsk[];
  updatedAt: string | null;
}) {
  const e = profile?.editing;
  const lines = briefLines(e);
  const brand = profile?.brandStyle.trim() || null;
  const customerNotes = e?.customerNotes ?? [];
  const revisionSummary = profile?.revisions.summary ?? "";
  const revisionTypes = profile?.revisions.commonTypes ?? [];
  const hasRevisionPicture = Boolean(revisionSummary || revisionTypes.length);

  return (
    <section className="overflow-hidden rounded-2xl border bg-surface">
      {/* THE AGENT UP TOP — their Aryeo headshot (initials when there isn't
          one) and their name as the title; "Working profile" is the small label
          underneath, not the headline (Jordan, round 4). The "what matters for
          the cut" reminder stays on the right where there is room for it. */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        {who ? (
          <Avatar name={who.name} src={who.avatarUrl} size={36} color="#4f46e5" />
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"><UserRound className="size-4" /></span>
        )}
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{who?.name ?? "Working profile"}</h2>
          {who && <div className="text-[11px] uppercase tracking-wide text-muted">Working profile</div>}
        </div>
        <span className="ml-auto hidden shrink-0 items-center gap-1 text-[11px] text-muted-2 sm:inline-flex" title="Only the parts of this client's profile that change the edit">
          <ShieldCheck className="size-3.5 text-brand" /> what matters for the cut
        </span>
      </div>

      <div className="space-y-4 px-5 py-4">
        {/* THE BRIEF — the editor's summary line (the generator writes one for
            v2 profiles), then every editing line in priority order, or the one
            honest line when there are none. */}
        {e?.summary || lines.length > 0 ? (
          <div className="space-y-3">
            {e?.summary && <p className="text-sm leading-relaxed text-foreground/90">{e.summary}</p>}
            {lines.length > 0 && <BriefList lines={lines} />}
          </div>
        ) : (
          <p className="text-sm text-muted">No standing editing preferences on record.</p>
        )}

        {/* Brand & style, the whole paragraph. Nothing is folded away any more,
            so there is no point clipping it to a first sentence. */}
        {brand && (
          <p className="flex gap-2 text-sm leading-relaxed text-foreground/90">
            <Palette className="mt-1 size-3.5 shrink-0 text-muted" />
            <span>{brand}</span>
          </p>
        )}

        <Bullets icon={<UserRound className="size-3.5" />} title="Customer notes" items={customerNotes} />

        {/* PAST REVISION REQUESTS — one section, titled the way Jordan asked
            ("Revisions should be titled (Past Revision Requests)"): the
            revision picture from the stored profile (how they tend to revise
            and the kinds of changes they ask for), then their actual recent
            asks, read live. Rendered only when there is something to show. */}
        {(hasRevisionPicture || asks.length > 0) && (
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"><Repeat className="size-3.5" /> Past Revision Requests</div>
            {revisionSummary && <p className="text-sm leading-relaxed text-foreground/90">{revisionSummary}</p>}
            {revisionTypes.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {revisionTypes.map((t, i) => (
                  <span key={i} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{t}</span>
                ))}
              </div>
            )}
            {asks.length > 0 && (
              <div className={hasRevisionPicture ? "mt-2.5" : undefined}>
                <RecentAsks asks={asks} />
              </div>
            )}
          </div>
        )}

        {/* Live counts + segment (liveProfileFacts), never the stored
            snapshot — Mike's card once said 34 orders against a header of 36. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Stat value={facts.totalOrders} label="Orders" />
          <Stat value={facts.revisions} label="Revisions" />
          {facts.segment && <SegmentBadge segment={facts.segment} size="xs" />}
        </div>

        {updatedAt && <div className="text-[11px] text-muted-2">Updated {updatedAt}</div>}
      </div>
    </section>
  );
}
