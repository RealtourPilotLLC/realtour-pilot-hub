import { UserRound, Palette, Repeat, Scissors, ThumbsUp, ThumbsDown, ShieldCheck } from "lucide-react";
import {
  editorView, liveProfileFacts, recentRevisionAsks,
  type ClientProfile, type EditorClientProfile, type ProfileFacts, type RevisionAsk,
} from "@/lib/clientProfile";
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
//   · everyone else  → the editor card below, built from editorView()
// The filter runs here, on the server, so the rapport and comms text is never
// serialized into an editor's browser at all. Same props as before, so the two
// call sites (/clients/<id> and /edit/<id>) need no change.
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
  const scope =
    audience ??
    (viewer
      ? viewer.role === "OWNER" || viewer.role === "ADMIN" ? "full" : "editor"
      : authEnforced() ? "editor" : "full");

  const [asks, facts] = await Promise.all([recentRevisionAsks(clientId), liveProfileFacts(clientId)]);

  if (scope === "editor") return <EditorProfileCard profile={editorView(profile)} facts={facts} asks={asks} updatedAt={updatedAt} />;
  return <ClientProfileCardView clientId={clientId} profile={profile} facts={facts} asks={asks} updatedAt={updatedAt} />;
}

// The editor's card: what this client wants done to the video, and nothing else.
// No regenerate button — rebuilding a profile is admin-only (requireAdmin in
// regenerateClientProfile), so offering an editor the button would only ever
// hand them "You don't have access to do that."
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
  // The counts are live, so they are worth showing on their own — but a card
  // with nothing BUT two numbers should say so rather than look broken.
  const hasBody = Boolean(
    e?.summary || e?.prefs.length || e?.customerNotes.length || e?.dos.length || e?.donts.length ||
      profile?.brandStyle || profile?.revisions.summary || profile?.revisions.commonTypes.length || asks.length,
  );

  return (
    <section className="overflow-hidden rounded-2xl border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg bg-brand-soft text-brand"><UserRound className="size-4" /></span>
        <h2 className="text-sm font-semibold">Working profile</h2>
        {facts.segment && <SegmentBadge segment={facts.segment} size="xs" />}
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-2" title="Only the parts of this client's profile that change the edit">
          <ShieldCheck className="size-3.5 text-brand" /> what matters for the cut
        </span>
      </div>

      <div className="space-y-4 px-5 py-4">
        {e?.summary && <p className="text-sm leading-relaxed text-foreground/90">{e.summary}</p>}

        <div className="grid grid-cols-2 gap-2">
          <Stat value={facts.totalOrders} label="Orders" />
          <Stat value={facts.revisions} label="Revisions" />
        </div>

        {!hasBody ? (
          <p className="text-sm text-muted">
            Nothing else on file for this client yet. Work from the job brief, their assets, and the photographer&rsquo;s notes.
          </p>
        ) : (
          <>
            <Bullets icon={<Scissors className="size-3.5" />} title="Editing preferences" items={e?.prefs ?? []} />
            <Bullets icon={<UserRound className="size-3.5" />} title="Customer notes" items={e?.customerNotes ?? []} />

            {profile?.brandStyle && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"><Palette className="size-3.5" /> Brand &amp; style</div>
                <p className="text-sm leading-relaxed text-foreground/90">{profile.brandStyle}</p>
              </div>
            )}

            {profile && (profile.revisions.summary || profile.revisions.commonTypes.length > 0) && (
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

            {(e && (e.dos.length > 0 || e.donts.length > 0)) && (
              <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
                {e.dos.length > 0 && (
                  <div>
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-success"><ThumbsUp className="size-3.5" /> Do</div>
                    <ul className="space-y-1">{e.dos.map((d, i) => <li key={i} className="text-sm leading-relaxed text-foreground/90">{d}</li>)}</ul>
                  </div>
                )}
                {e.donts.length > 0 && (
                  <div>
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-danger"><ThumbsDown className="size-3.5" /> Avoid</div>
                    <ul className="space-y-1">{e.donts.map((d, i) => <li key={i} className="text-sm leading-relaxed text-foreground/90">{d}</li>)}</ul>
                  </div>
                )}
              </div>
            )}

            {/* A profile written before the audience split has no editing block
                yet. Say so plainly rather than looking like this client has no
                preferences: the nightly rebuild fills it in. */}
            {profile && profile.v < 2 && !e?.prefs.length && !e?.customerNotes.length && (
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
                Editing notes for this client are still being written up. Check the job brief and the client&rsquo;s assets for this cut.
              </p>
            )}

            {updatedAt && <div className="border-t border-border pt-2 text-[11px] text-muted-2">Updated {updatedAt}</div>}
          </>
        )}
      </div>
    </section>
  );
}
