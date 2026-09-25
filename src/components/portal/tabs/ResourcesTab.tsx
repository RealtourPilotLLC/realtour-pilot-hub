import { BookOpen, Clock } from "lucide-react";
import { COMING_SOON, type ResourceGroupView } from "@/lib/portalResources";
import { Card, Empty, LoadFailed, fmtShort } from "@/components/portal/ui";
import { ContactTeam, type PortalContact } from "@/components/portal/ContactTeam";
import { Markdown } from "@/components/ui/Markdown";

// RESOURCES (spec §11): published guides in their groups, mobile-readable
// (one column, collapsible), each with its owner, last-reviewed date and the
// platform/device it was written for. Unpublished rows never reach this
// component; an empty group says so instead of showing a placeholder.
//
// CP-13: what is promised but not written (Instagram publishing, the advanced
// guides) is listed as "Coming soon" from code, never as a row that could be
// published half-done; and the empty page offers the conversation and Kyle's
// line instead of "text us" with nothing to text.
export function ResourcesTab({ groups, failed, open, contact, messagesHref }: {
  groups: ResourceGroupView[] | null;
  failed: boolean;
  open: string | undefined;
  contact: PortalContact;
  /** null = this viewer cannot write on the conversation (view-only, paused). */
  messagesHref: string | null;
}) {
  if (failed) return <div className="mt-6"><LoadFailed what="the guides" /></div>;
  if (!groups) return null;
  const total = groups.reduce((n, g) => n + g.resources.length, 0);
  return (
    <div className="mt-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Resources</h1>
        <p className="mt-0.5 text-xs text-muted">Short guides for each step, written and kept current by the team.</p>
      </div>
      {total === 0 ? (
        <>
          <Empty icon={BookOpen}>No guides are published yet. Ask us anything in the meantime: the answer usually becomes the next guide.</Empty>
          <ContactTeam contact={contact} messagesHref={messagesHref} />
        </>
      ) : (
        groups.map((g) => (
          <Card key={g.key}>
            <h2 className="text-base font-semibold">{g.title}</h2>
            <p className="text-xs text-muted">{g.blurb}</p>
            {g.resources.length === 0 ? (
              <p className="mt-2 text-xs text-muted-2">Nothing here yet.</p>
            ) : (
            <div className="mt-3 space-y-2">
              {g.resources.map((r) => (
                <details key={r.id} id={r.slug} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3" open={open === r.slug}>
                  <summary className="cursor-pointer text-sm font-bold">
                    {r.title}
                    {(r.platform || r.deviceContext) && <span className="ml-2 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{[r.platform, r.deviceContext].filter((x) => x && x !== "general" && x !== "any").join(" · ") || "all platforms"}</span>}
                  </summary>
                  {r.summary && <p className="mt-1 text-xs text-muted">{r.summary}</p>}
                  <Markdown content={r.body} className="mt-2 break-words text-sm" />
                  <p className="mt-2 text-[11px] text-muted-2">{r.ownerName ? `Kept current by ${r.ownerName}` : "Kept current by the team"}{r.reviewedAtISO ? ` · last reviewed ${fmtShort(r.reviewedAtISO)}` : " · not yet reviewed"}</p>
                </details>
              ))}
            </div>
            )}
          </Card>
        ))
      )}
      <Card>
        <h2 className="text-base font-semibold">On the way</h2>
        <ul className="mt-2 space-y-2">
          {COMING_SOON.map((c) => (
            <li key={c.key} className="flex items-start gap-2 rounded-xl border border-dashed border-border px-4 py-3">
              <Clock className="mt-0.5 size-4 shrink-0 text-muted-2" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {c.title}
                  <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Coming soon</span>
                </div>
                <p className="mt-0.5 text-xs text-muted">{c.blurb}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
