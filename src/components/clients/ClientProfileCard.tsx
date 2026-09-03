import { UserRound, Palette, Repeat, ShieldCheck, ChevronDown, Ban, Check } from "lucide-react";
import {
  editorView, liveProfileFacts, recentRevisionAsks,
  type ClientProfile, type EditorClientProfile, type ProfileFacts, type RevisionAsk,
} from "@/lib/clientProfile";
import { clip } from "@/lib/text";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
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
// So this entry point is a SERVER component that resolves the viewer's role and
// hands each audience its own card:
//   · OWNER / ADMIN  → the whole profile (it is genuinely how Jordan and Kyle work)
//   · everyone else  → the editor's brief below, built from editorView()
// The filter runs here, on the server, so the rapport and comms text is never
// serialized into an editor's browser at all. Same props as before, so the two
// call sites (/clients/<id> and /edit/<id>) need no change.
//
// Second round, same day, on the editor's card: "I feel like the working
// profile should be a brief summary, with the most important information first
// for the editor… it's too long and too much to sift through. Maybe add a
// dropdown for more info, but only show the main things the editor needs to
// know for editing and to provide a good client experience." Hence
// EditorProfileCard is now a BRIEF with a fold — see it below.
// ---------------------------------------------------------------------------

export async function ClientProfileCard({
  clientId,
  profile,
  updatedAt,
  audience,
}: {
  clientId: string;
  profile: ClientProfile | null;
  updatedAt: string | null;
  /** Force a view. Omitted = decide from the signed-in viewer's role. */
  audience?: "full" | "editor";
}) {
  const viewer = await getCurrentUser();
  // Fail to the NARROW view when we can't prove who's looking — except in local
  // open mode, where there is no session at all and Jordan is the only user.
  // The brief is written for the EDITOR role (John and Kim on /edit); any other
  // non-owner/admin viewer lands on the same narrow card, never the full one.
  const scope =
    audience ??
    (viewer
      ? viewer.role === "OWNER" || viewer.role === "ADMIN" ? "full" : "editor"
      : authEnforced() ? "editor" : "full");

  const [asks, facts] = await Promise.all([recentRevisionAsks(clientId), liveProfileFacts(clientId)]);

  if (scope === "editor") return <EditorProfileCard profile={editorView(profile)} facts={facts} asks={asks} updatedAt={updatedAt} />;
  return <ClientProfileCardView clientId={clientId} profile={profile} facts={facts} asks={asks} updatedAt={updatedAt} />;
}

// ---------------------------------------------------------------------------
// THE EDITOR'S BRIEF.
//
// Above the fold, only what decides the cut and keeps the client happy, most
// important first: the standing preferences (logos, endcards, music), then the
// hard "never" rules, then the advice lines — at most TOP_LINES of them, filled
// in that order so a fifth preference can push an advice line under the fold
// but never a "never" — and then a ONE-line brand/style read. Everything else
// that is editor-safe (customer notes, the revision picture, recent asks, the
// counts, the segment, the full brand paragraph) waits under "More about this
// client", closed by default.
//
// When the editing block is empty (72 of 215 clients the day this shipped) the
// top says so in one honest line instead of rendering empty headings.
//
// No regenerate button — rebuilding a profile is admin-only (requireAdmin in
// regenerateClientProfile), so offering an editor the button would only ever
// hand them "You don't have access to do that."
// ---------------------------------------------------------------------------

const TOP_LINES = 5;

type BriefLine = { kind: "pref" | "never" | "do"; text: string };

// The lines an editor reads before opening the timeline, in priority order.
// `prefs` are the standing instructions for the finished video, `donts` the
// hard rules, `dos` the advice; editorView() has already done the audience
// filtering, so this only orders and splits at the fold.
function briefLines(e: EditorClientProfile["editing"] | undefined): { top: BriefLine[]; rest: BriefLine[] } {
  const all: BriefLine[] = [
    ...(e?.prefs ?? []).map((text) => ({ kind: "pref" as const, text })),
    ...(e?.donts ?? []).map((text) => ({ kind: "never" as const, text })),
    ...(e?.dos ?? []).map((text) => ({ kind: "do" as const, text })),
  ];
  return { top: all.slice(0, TOP_LINES), rest: all.slice(TOP_LINES) };
}

// "The one-line brand/style read." The stored brandStyle is a paragraph (Mike
// Ciunci's runs three sentences), so the brief shows its first sentence, clipped
// at a line's worth, and the whole paragraph waits under More.
const BRAND_LINE = 170;
function brandRead(s: string): { line: string; shortened: boolean } {
  const whole = s.trim();
  const first = whole.split(/(?<=[.!?])\s+/)[0] ?? whole;
  const line = clip(first, BRAND_LINE);
  return { line, shortened: line !== whole };
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
  profile,
  facts,
  asks,
  updatedAt,
}: {
  profile: EditorClientProfile | null;
  facts: ProfileFacts;
  asks: RevisionAsk[];
  updatedAt: string | null;
}) {
  const e = profile?.editing;
  const { top, rest } = briefLines(e);
  const brand = profile?.brandStyle ? brandRead(profile.brandStyle) : null;
  const customerNotes = e?.customerNotes ?? [];
  const hasRevisionPicture = Boolean(profile?.revisions.summary || profile?.revisions.commonTypes.length);

  // What the fold holds, named on its handle so an editor knows whether it is
  // worth opening. The counts are live, so they are always there.
  const moreParts = [
    rest.length > 0 ? `${rest.length} more editing note${rest.length === 1 ? "" : "s"}` : null,
    customerNotes.length > 0 ? "customer notes" : null,
    hasRevisionPicture ? "revision habits" : null,
    asks.length > 0 ? `${asks.length} recent ask${asks.length === 1 ? "" : "s"}` : null,
    `${facts.totalOrders} order${facts.totalOrders === 1 ? "" : "s"}`,
  ].filter((p): p is string => Boolean(p));

  return (
    <section className="overflow-hidden rounded-2xl border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg bg-brand-soft text-brand"><UserRound className="size-4" /></span>
        <h2 className="text-sm font-semibold">Working profile</h2>
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-2" title="Only the parts of this client's profile that change the edit">
          <ShieldCheck className="size-3.5 text-brand" /> what matters for the cut
        </span>
      </div>

      <div className="space-y-3 px-5 py-4">
        {/* THE BRIEF — the editor's summary line (the generator writes one for
            v2 profiles), then the ordered lines, or the one honest line. */}
        {e?.summary && <p className="text-sm leading-relaxed text-foreground/90">{e.summary}</p>}

        {top.length > 0 ? (
          <BriefList lines={top} />
        ) : (
          !e?.summary && <p className="text-sm text-muted">No standing editing preferences on record.</p>
        )}

        {brand && (
          <p className="flex gap-2 text-sm leading-relaxed text-foreground/90">
            <Palette className="mt-1 size-3.5 shrink-0 text-muted" />
            <span>{brand.line}</span>
          </p>
        )}

        {/* THE FOLD — Jordan's "dropdown for more info". Native <details>, so
            no client JS in a server component. */}
        <details className="group/more rounded-xl border border-border bg-surface-2/30">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2 text-[13px] font-medium text-muted hover:text-foreground">
            <ChevronDown className="size-3.5 shrink-0 -rotate-90 transition-transform group-open/more:rotate-0" />
            More about this client
            <span className="text-[11px] font-normal text-muted-2">— {moreParts.join(" · ")}</span>
          </summary>
          <div className="space-y-4 border-t border-border px-3.5 py-3">
            {rest.length > 0 && (
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">More editing notes</div>
                <BriefList lines={rest} />
              </div>
            )}

            <Bullets icon={<UserRound className="size-3.5" />} title="Customer notes" items={customerNotes} />

            {brand?.shortened && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"><Palette className="size-3.5" /> Brand &amp; style, in full</div>
                <p className="text-sm leading-relaxed text-foreground/90">{profile!.brandStyle}</p>
              </div>
            )}

            {profile && hasRevisionPicture && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"><Repeat className="size-3.5" /> Revisions</div>
                {profile.revisions.summary && <p className="text-sm leading-relaxed text-foreground/90">{profile.revisions.summary}</p>}
                {profile.revisions.commonTypes.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {profile.revisions.commonTypes.map((t, i) => (
                      <span key={i} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{t}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <RecentAsks asks={asks} />

            {/* Live counts + segment (liveProfileFacts), never the stored
                snapshot — Mike's card once said 34 orders against a header of 36. */}
            <div className="flex flex-wrap items-center gap-2">
              <Stat value={facts.totalOrders} label="Orders" />
              <Stat value={facts.revisions} label="Revisions" />
              {facts.segment && <SegmentBadge segment={facts.segment} size="xs" />}
            </div>

            {updatedAt && <div className="border-t border-border pt-2 text-[11px] text-muted-2">Updated {updatedAt}</div>}
          </div>
        </details>
      </div>
    </section>
  );
}
