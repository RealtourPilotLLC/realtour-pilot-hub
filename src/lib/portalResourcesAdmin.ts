import "server-only";
import { prisma } from "@/lib/prisma";
import { RESOURCE_GROUPS } from "@/lib/portalResources";

// ---------------------------------------------------------------------------
// RESOURCES — AUTHORING (spec §11). Staff write and maintain the client guides
// here; the client-facing read (publishedResources) is W2-D's and only ever
// sees published rows. Rules this file keeps:
//   · a new guide is UNPUBLISHED — nothing a client can see appears by
//     accident, and no placeholder ever ships as finished guidance;
//   · every guide has an owner and a last-reviewed date, because platform
//     instructions rot (§11: maintain them as platforms change);
//   · edits need no deploy — the body is markdown in the row.
// Nothing is seeded: the four groups exist as CODE (portalResources.ts) so an
// empty group renders as empty, and the first guide is written by a person.
// ---------------------------------------------------------------------------

export { RESOURCE_GROUPS };
export const PLATFORMS = ["general", "instagram", "facebook", "tiktok", "youtube", "linkedin"] as const;
export const DEVICES = ["any", "ios", "android", "desktop"] as const;

export type ResourceInput = {
  title: string; groupKey: string; summary?: string | null; body: string; platform?: string | null; deviceContext?: string | null;
  ownerAppUserId?: string | null; linkedActions?: string[]; sortOrder?: number | null;
};

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "guide";

function validate(input: ResourceInput): void {
  if (!input.title?.trim() || input.title.trim().length < 3) throw new Error("A guide needs a title.");
  if (!RESOURCE_GROUPS.some((g) => g.key === input.groupKey)) throw new Error("Pick one of the four resource groups.");
  if (!input.body?.trim()) throw new Error("A guide needs a body — an empty guide is a placeholder, and placeholders are not published.");
  if (input.platform && !(PLATFORMS as readonly string[]).includes(input.platform)) throw new Error("Unknown platform.");
  if (input.deviceContext && !(DEVICES as readonly string[]).includes(input.deviceContext)) throw new Error("Unknown device context.");
}

export async function createResource(input: ResourceInput, by: string | null): Promise<{ id: string; slug: string }> {
  validate(input);
  let slug = slugify(input.title);
  for (let n = 2; await prisma.portalResource.findUnique({ where: { slug }, select: { id: true } }); n++) slug = `${slugify(input.title)}-${n}`;
  const r = await prisma.portalResource.create({
    data: {
      slug, groupKey: input.groupKey, title: input.title.trim(), summary: input.summary?.trim() || null, body: input.body, platform: input.platform || null, deviceContext: input.deviceContext || null,
      ownerAppUserId: input.ownerAppUserId || null, linkedActions: input.linkedActions?.length ? JSON.stringify(input.linkedActions) : null, sortOrder: input.sortOrder ?? 0,
      published: false, createdBy: by,
    },
    select: { id: true, slug: true },
  });
  return r;
}

export async function updateResource(id: string, input: ResourceInput): Promise<void> {
  validate(input);
  await prisma.portalResource.update({
    where: { id },
    data: {
      groupKey: input.groupKey, title: input.title.trim(), summary: input.summary?.trim() || null, body: input.body, platform: input.platform || null, deviceContext: input.deviceContext || null,
      ownerAppUserId: input.ownerAppUserId || null, linkedActions: input.linkedActions?.length ? JSON.stringify(input.linkedActions) : null, sortOrder: input.sortOrder ?? 0,
    },
  });
}

/** Publish = a person vouches for the guide today; it also stamps the review date. Unpublish hides it immediately. */
export async function setResourcePublished(id: string, published: boolean, by: string | null): Promise<void> {
  const r = await prisma.portalResource.findUnique({ where: { id }, select: { body: true, ownerAppUserId: true } });
  if (!r) throw new Error("Guide not found.");
  if (published) {
    if (!r.body.trim() || /\b(TODO|TBD|lorem ipsum|placeholder)\b/i.test(r.body)) throw new Error("This guide still reads as a placeholder (TODO / TBD / placeholder text) — finish it before publishing.");
    if (!r.ownerAppUserId) throw new Error("Give the guide an owner before publishing — someone has to keep it current.");
  }
  await prisma.portalResource.update({ where: { id }, data: published ? { published: true, reviewedAt: new Date(), reviewedBy: by } : { published: false } });
}

export async function markResourceReviewed(id: string, by: string | null): Promise<void> {
  await prisma.portalResource.update({ where: { id }, data: { reviewedAt: new Date(), reviewedBy: by } });
}

export type ResourceAdminRow = {
  id: string; slug: string; groupKey: string; title: string; summary: string | null; body: string; platform: string | null; deviceContext: string | null;
  ownerAppUserId: string | null; ownerName: string | null; reviewedAt: Date | null; reviewedBy: string | null; linkedActions: string[]; published: boolean; sortOrder: number; updatedAt: Date;
  /** > 90 days since review, or never reviewed while published — the "stale" flag §11 asks for. */
  stale: boolean;
};

export async function listResourcesForAdmin(): Promise<ResourceAdminRow[]> {
  const rows = await prisma.portalResource.findMany({ orderBy: [{ groupKey: "asc" }, { sortOrder: "asc" }, { title: "asc" }] });
  const ownerIds = [...new Set(rows.map((r) => r.ownerAppUserId).filter((x): x is string => !!x))];
  const owners = ownerIds.length ? await prisma.appUser.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, email: true } }) : [];
  const nameOf = new Map(owners.map((o) => [o.id, o.name ?? o.email]));
  const cutoff = Date.now() - 90 * 864e5;
  return rows.map((r) => {
    let linked: string[] = [];
    try { const v = r.linkedActions ? JSON.parse(r.linkedActions) : []; if (Array.isArray(v)) linked = v.filter((x): x is string => typeof x === "string"); } catch { /* none */ }
    return {
      id: r.id, slug: r.slug, groupKey: r.groupKey, title: r.title, summary: r.summary, body: r.body, platform: r.platform, deviceContext: r.deviceContext,
      ownerAppUserId: r.ownerAppUserId, ownerName: r.ownerAppUserId ? nameOf.get(r.ownerAppUserId) ?? null : null, reviewedAt: r.reviewedAt, reviewedBy: r.reviewedBy, linkedActions: linked,
      published: r.published, sortOrder: r.sortOrder, updatedAt: r.updatedAt, stale: r.published && (!r.reviewedAt || r.reviewedAt.getTime() < cutoff),
    };
  });
}

/** The task/action keys a guide can be linked from (spec §11 "link guides directly from the related task"). */
export const LINKABLE_ACTIONS: { key: string; label: string }[] = [
  { key: "prepare_session", label: "Preparing for a filming session" },
  { key: "answer_interview", label: "Answering topic questions" },
  { key: "review_cut", label: "Reviewing a cut" },
  { key: "approve_cut", label: "Approving a video" },
  { key: "download_final", label: "Downloading the final file" },
  { key: "post_video", label: "Posting a video" },
  { key: "edit_caption", label: "Editing a caption" },
  { key: "choose_cover", label: "Choosing a thumbnail / cover" },
  { key: "reuse_video", label: "Reusing a video" },
  { key: "improve_results", label: "Improving results" },
];
