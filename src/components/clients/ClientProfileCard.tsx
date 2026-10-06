import { ChevronDown, Palette, Repeat, Type, ImageIcon } from "lucide-react";
import {
  agentProfileFor, liveProfileFacts, recentRevisionAsks,
  type AgentProfileData, type AgentStyleSource, type ClientProfile,
} from "@/lib/clientProfile";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { Avatar } from "@/components/ui/Avatar";
import { SegmentBadge } from "@/components/clients/SegmentBadge";
import { ClientProfileCardView } from "@/components/clients/ClientProfileCardView";
import { RecentAsks } from "@/components/clients/profileParts";

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
// for the editor… it's too long and too much to sift through." Hence the
// brief form carries only the editor-safe parts, most important first.
//
// Fourth round (Sep 2, evening): the agent's name and Aryeo headshot up top,
// and "Past Revision Requests" as the revision heading.
//
// Fifth round (Oct 5), onboarding the first content client: the brief form is
// now the AGENT PROFILE — collapsed by default to the agent's name and photo,
// brokerage, team, segment badge and a one-or-two-sentence summary; expanding
// it shows "Style & brand" (colours with hex, fonts, logo, style preferences
// from the portal's brand setup and the Aryeo customer note). One component,
// AgentProfileCard below, wherever the brief appears — the editor's /edit
// page renders it directly with the brand it already loaded.
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
   * Which form the PAGE wants: "brief" is the editor-safe Agent Profile;
   * "full" is the whole working profile. Omitted = decide from the signed-in
   * viewer's role (owner/admin full, others brief).
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

  if (scope === "brief") {
    // links:false — the file NAMES are what this card needs; minting a
    // Dropbox link per logo on every client-page load is not.
    const agent = await agentProfileFor(clientId, { links: false }).catch(() => null);
    return agent ? <AgentProfileCard agent={agent} /> : null;
  }
  const [asks, facts] = await Promise.all([recentRevisionAsks(clientId), liveProfileFacts(clientId)]);
  return <ClientProfileCardView clientId={clientId} profile={profile} facts={facts} asks={asks} updatedAt={updatedAt} />;
}

// ---------------------------------------------------------------------------
// THE AGENT PROFILE — collapsed by default (a native <details>, so it opens
// with no script and stays closed until someone asks). Closed it is one short
// block: photo, name, segment, brokerage · team, the summary. Open, it adds
// "Style & brand" and the client's last few change requests. Never pricing:
// the loader money-scrubs every line, and the segment is its short badge only.
// ---------------------------------------------------------------------------

const FROM_WORDS: Record<AgentStyleSource, string> = {
  portal: "from their portal",
  aryeo: "from their Aryeo notes",
  profile: "from past jobs",
};

export function AgentProfileCard({
  agent,
  hidePreferencesFrom = [],
  linkLogo = true,
  id,
}: {
  agent: AgentProfileData;
  /** Preference sources the page already prints elsewhere (the editor brief shows the portal's own words beside the card). */
  hidePreferencesFrom?: AgentStyleSource[];
  /** False when the page links the logo file elsewhere — one link per file on a screen. */
  linkLogo?: boolean;
  id?: string;
}) {
  const s = agent.style;
  const prefs = s.preferences.filter((p) => !hidePreferencesFrom.includes(p.from));
  const hasStyle = s.colors.length > 0 || !!s.colorWords || !!s.fonts || !!s.logo || prefs.length > 0;
  const subline = [agent.brokerage, agent.team ? `Team: ${agent.team}` : null].filter(Boolean).join(" · ");
  return (
    <details id={id} data-agent-profile className="group min-w-0 rounded-2xl border border-border bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-start gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
        <Avatar name={agent.name} src={agent.avatarUrl} size={40} color="#4f46e5" />
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-2">Agent Profile</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold">{agent.name}</span>
            {agent.segment && <SegmentBadge segment={agent.segment} size="xs" />}
          </span>
          {subline && <span className="block text-xs text-muted">{subline}</span>}
          <span className="mt-1 block text-sm leading-relaxed text-foreground/85">{agent.summary}</span>
        </span>
        <ChevronDown aria-hidden className="mt-1 size-4 shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t border-border px-4 py-3">
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"><Palette className="size-3.5" /> Style &amp; brand</h3>
          {!hasStyle && <p className="text-sm text-muted">Nothing on file yet — no colours, fonts or logo from their portal or their Aryeo notes.</p>}
          {s.colors.length > 0 && (
            <div className="flex flex-wrap items-center gap-2" data-agent-colors>
              {s.colors.map((c) => (
                <span key={c.hex} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs font-medium">
                  <span aria-hidden className="size-4 rounded border border-border" style={{ backgroundColor: c.hex }} /> {c.hex.toUpperCase()}
                </span>
              ))}
              <span className="text-[11px] text-muted-2">{FROM_WORDS[s.colors[0].from]}</span>
            </div>
          )}
          {s.colorWords && <p className="mt-1 text-xs text-muted">{s.colorWords}</p>}
          {s.fonts && (
            <p className="mt-2 flex items-start gap-1.5 text-sm"><Type className="mt-0.5 size-3.5 shrink-0 text-muted" /><span><span className="text-muted">Fonts:</span> {s.fonts.text} <span className="text-[11px] text-muted-2">{FROM_WORDS[s.fonts.from]}</span></span></p>
          )}
          {s.logo && (
            <p className="mt-2 flex items-start gap-1.5 text-sm"><ImageIcon className="mt-0.5 size-3.5 shrink-0 text-muted" /><span><span className="text-muted">Logo:</span>{" "}
              {linkLogo && s.logo.url ? <a href={s.logo.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">{s.logo.name}</a> : s.logo.name}
            </span></p>
          )}
          {prefs.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {prefs.map((p, i) => (
                <li key={i} className="flex gap-2 text-sm leading-relaxed text-foreground/90">
                  <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-brand/60" />
                  <span>{p.text} <span className="text-[11px] text-muted-2">{FROM_WORDS[p.from]}</span></span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {agent.pastAsks.length > 0 && (
          <div>
            <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"><Repeat className="size-3.5" /> Past Revision Requests</h3>
            <RecentAsks asks={agent.pastAsks} />
          </div>
        )}
      </div>
    </details>
  );
}
