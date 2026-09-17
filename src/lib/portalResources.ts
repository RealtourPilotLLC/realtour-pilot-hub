import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// RESOURCES (spec §11). Staff-authored guides (PortalResource rows — the
// authoring UI is the business workspace's) grouped for the client. Only
// PUBLISHED rows ever render; an unpublished draft is invisible here, so a
// half-written guide can never be mistaken for finished guidance. Rows are
// global (a guide is the same for every client), so nothing here is scoped to
// an enrollment and nothing here writes.
// ---------------------------------------------------------------------------

export const RESOURCE_GROUPS: { key: string; title: string; blurb: string }[] = [
  { key: "PREPARING_SESSION", title: "Preparing for your session", blurb: "What to have ready before we film." },
  { key: "REVIEWING_VIDEOS", title: "Reviewing videos", blurb: "How to watch, note and approve a cut." },
  { key: "POSTING_CONTENT", title: "Posting your content", blurb: "Uploads, quality settings, captions and covers." },
  { key: "IMPROVING_RESULTS", title: "Improving results", blurb: "Getting more from every video." },
];

export type ResourceView = {
  id: string;
  slug: string;
  groupKey: string;
  title: string;
  summary: string | null;
  body: string; // markdown
  platform: string | null;
  deviceContext: string | null;
  reviewedAtISO: string | null;
  ownerName: string | null;
  linkedActions: string[];
};

export type ResourceGroupView = { key: string; title: string; blurb: string; resources: ResourceView[] };

/** Published guides, grouped in the spec's four groups (empty groups included so the page can say so). */
export async function publishedResources(): Promise<ResourceGroupView[]> {
  const rows = await prisma.portalResource.findMany({ where: { published: true }, orderBy: [{ groupKey: "asc" }, { sortOrder: "asc" }, { title: "asc" }] });
  const ownerIds = [...new Set(rows.map((r) => r.ownerAppUserId).filter((x): x is string => !!x))];
  const owners = ownerIds.length ? await prisma.appUser.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(owners.map((o) => [o.id, o.name]));
  const view = (r: (typeof rows)[number]): ResourceView => {
    let linked: string[] = [];
    try { const v = r.linkedActions ? JSON.parse(r.linkedActions) : []; if (Array.isArray(v)) linked = v.filter((x): x is string => typeof x === "string"); } catch { /* none */ }
    return { id: r.id, slug: r.slug, groupKey: r.groupKey, title: r.title, summary: r.summary, body: r.body, platform: r.platform, deviceContext: r.deviceContext, reviewedAtISO: r.reviewedAt?.toISOString() ?? null, ownerName: r.ownerAppUserId ? nameOf.get(r.ownerAppUserId) ?? null : null, linkedActions: linked };
  };
  return RESOURCE_GROUPS.map((g) => ({ ...g, resources: rows.filter((r) => r.groupKey === g.key).map(view) }));
}

/** Published guides linked from a task/action key (e.g. "review_cut", "download_final", "post_video"). */
export async function resourcesForAction(actionKey: string): Promise<{ slug: string; title: string }[]> {
  const rows = await prisma.portalResource.findMany({ where: { published: true }, select: { slug: true, title: true, linkedActions: true } });
  return rows.filter((r) => { try { const v = r.linkedActions ? JSON.parse(r.linkedActions) : []; return Array.isArray(v) && v.includes(actionKey); } catch { return false; } }).map((r) => ({ slug: r.slug, title: r.title }));
}
