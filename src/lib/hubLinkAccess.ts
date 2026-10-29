import "server-only";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/auth/user";
import { canAccess, PAGES, type PageKey } from "@/lib/auth/access";
import { authEnforced, canViewProject } from "@/lib/auth/guards";
import {
  HUB_LINK_LABEL,
  MAX_LINKS_PER_MESSAGE,
  hubLinkKey,
  hubLinkPath,
  isPageKey,
  type HubLinkRef,
  type HubLinkTarget,
  type HubLinkView,
} from "@/lib/hubLinks";
import type { ConversationRef } from "@/lib/messageFiles";

// ---------------------------------------------------------------------------
// WHO MAY OPEN A LINKED PAGE, AND WHO READS A CONVERSATION (Jordan, Oct 28
// 2026: "if it links to something, the people receiving it would have to be
// authorized to view it, so only pages that are authorized for everyone
// should be shareable").
//
// THE RULE: a page can go on a message only if EVERY person who can read that
// conversation is allowed to open it: their role's pages, their own page
// switches (People → access), and job scoping (an editor not on the job, a
// photographer who didn't shoot it). In the team channel that is everyone on
// the team. The picker offers only pages that pass; the send action asks
// again and refuses with the person's name; and a card is drawn without its
// link for anyone who can't open it any more.
//
// canOpenHubLink mirrors each page's OWN gate, read off the page (Oct 28
// 2026). When one of those gates changes, this table must change with it:
//   /projects/<id>              owner, office, creative manager (others bounced)
//   /edit/<id>                  not a photographer; canViewProject
//   /shoot/<id>                 owner, office, creative manager; the photographer who shot it
//   /review/<id>                the `review` page and the review desk, or the photographer who shot it
//   /ops/photo-delivery/<job>   the `photos` page
//   /clients/<id>               the `clients` page
//   /upload/<id>                the `upload` page; a photographer only on a shoot they may upload to
//   a menu page                 that page's switch (canAccess)
// Titles carry an address, a client's name or a page's name. Never an amount.
// ---------------------------------------------------------------------------

export const TEAM_ROLES = ["OWNER", "ADMIN", "CREATIVE_MANAGER", "EDITOR", "PHOTOGRAPHER"] as const;

type AppUserRow = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null;
};

/** An AppUser row as the guards read a viewer: their own login, never a preview. */
export function viewerFromAppUser(u: AppUserRow): CurrentUser {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, permissions: u.permissions, status: u.status,
    teamMemberId: u.teamMemberId, editorKey: u.editorKey, notificationsSeenAt: null,
    impersonating: false, realRole: u.role, realName: u.name,
  };
}

/** The first name a refusal names a person by. */
export function firstNameOf(v: { name: string | null; email: string }): string {
  return (v.name ?? "").trim().split(/\s+/)[0] || v.email.split("@")[0] || "Someone";
}

const LEAD = (role: string) => role === "OWNER" || role === "ADMIN" || role === "CREATIVE_MANAGER";

/** May this person read this job's thread? The thread's own gate (messageActions
 *  requireThreadAccess), asked of any login: the job's material (canViewProject),
 *  or an editor who already spoke on it. */
async function canReadJobThread(v: CurrentUser, projectId: string): Promise<boolean> {
  if (await canViewProject(projectId, v)) return true;
  if (v.role === "EDITOR" && v.teamMemberId) {
    const prior = await prisma.projectMessage.findFirst({ where: { projectId, authorId: v.teamMemberId }, select: { id: true } });
    return !!prior;
  }
  return false;
}

/** May this viewer read this conversation (and so fetch its files)? The team
 *  channel: anyone signed in to the hub with a team role. A job thread: its own gate. */
export async function canReadConversation(v: CurrentUser | null, c: ConversationRef): Promise<boolean> {
  if (!v) return !authEnforced();
  if (!(TEAM_ROLES as readonly string[]).includes(v.role)) return false;
  if (c.kind === "team") return true;
  return canReadJobThread(v, c.projectId);
}

/** Every active login that can read this conversation. Editors and
 *  photographers first: they are the ones a job page usually refuses, so a
 *  check that stops at the first "no" stops early. */
export async function conversationReaders(c: ConversationRef): Promise<CurrentUser[]> {
  const users = await prisma.appUser.findMany({
    where: { status: "ACTIVE", role: { in: [...TEAM_ROLES] } },
    select: { id: true, email: true, name: true, role: true, permissions: true, status: true, teamMemberId: true, editorKey: true },
    orderBy: { createdAt: "asc" },
  });
  const rank = (r: string) => (r === "EDITOR" ? 0 : r === "PHOTOGRAPHER" ? 1 : r === "CREATIVE_MANAGER" ? 2 : 3);
  const viewers = users.map(viewerFromAppUser).sort((a, b) => rank(a.role) - rank(b.role));
  if (c.kind === "team") return viewers;
  const out: CurrentUser[] = [];
  for (const v of viewers) if (await canReadJobThread(v, c.projectId)) out.push(v);
  return out;
}

/** Can this person open this page? The page's own gate (table above). */
export async function canOpenHubLink(v: CurrentUser, t: HubLinkTarget): Promise<boolean> {
  if (v.status && v.status !== "ACTIVE") return false;
  switch (t.kind) {
    case "project":
      return LEAD(v.role);
    case "edit":
      return v.role !== "PHOTOGRAPHER" && (await canViewProject(t.id, v));
    case "shoot": {
      if (LEAD(v.role)) return true;
      if (v.role !== "PHOTOGRAPHER") return false;
      const { photographerMemberId, photographerOwnsShoot } = await import("@/lib/shoot");
      const mid = await photographerMemberId(v);
      return !!mid && (await photographerOwnsShoot(t.id, mid));
    }
    case "review": {
      if (!canAccess(v, "review")) return false;
      const { isReviewDesk } = await import("@/lib/reviewerAssignment");
      if (await isReviewDesk(v, { authEnforced: true })) return true;
      if (v.role !== "PHOTOGRAPHER" || !v.teamMemberId) return false;
      const { photographerOwnsShoot } = await import("@/lib/shoot");
      return photographerOwnsShoot(t.id, v.teamMemberId);
    }
    case "photos":
      return canAccess(v, "photos");
    case "client":
      return canAccess(v, "clients");
    case "upload": {
      if (!canAccess(v, "upload")) return false;
      if (v.role !== "PHOTOGRAPHER") return true;
      const { photographerMemberId, photographerMayUpload } = await import("@/lib/shoot");
      const mid = await photographerMemberId(v);
      return !!mid && (await photographerMayUpload(t.id, mid));
    }
    case "page":
      return isPageKey(t.id) && canAccess(v, t.id as PageKey);
  }
}

const streetOf = (p: { addressLine: string | null; title: string }) => (p.addressLine || p.title.split(",")[0] || "Job").trim();

/** The card's title, from the hub's own records; null when the page's record is gone. */
export async function hubLinkTitle(t: HubLinkTarget): Promise<string | null> {
  if (t.kind === "page") return PAGES.find((p) => p.key === t.id)?.label ?? null;
  if (t.kind === "client") {
    const c = await prisma.client.findUnique({ where: { id: t.id }, select: { name: true } });
    return c ? `${c.name} · ${HUB_LINK_LABEL.client}` : null;
  }
  const projectId = t.kind === "photos" ? (await prisma.photoJob.findUnique({ where: { id: t.id }, select: { projectId: true } }))?.projectId : t.id;
  if (!projectId) return null;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { addressLine: true, title: true } });
  if (!p) return null;
  let label: string = HUB_LINK_LABEL[t.kind];
  if (t.kind === "review" && t.cut) {
    const sub = await prisma.reviewSubmission.findUnique({ where: { id: t.cut }, select: { projectId: true, fileName: true, round: true } });
    if (!sub || sub.projectId !== projectId) return null;
    const name = (sub.fileName ?? "").replace(/\.[a-z0-9]{2,4}$/i, "").trim().slice(0, 50);
    label = `${label} (${name ? `${name}, ` : ""}v${sub.round})`;
  }
  return `${streetOf(p)} · ${label}`;
}

/** "Kim", "Kim and John", "Kim, John and Harrison", "Kim, John and 2 others". */
export function namesLine(names: string[]): string {
  const u = Array.from(new Set(names));
  if (u.length <= 1) return u[0] ?? "Someone";
  if (u.length === 2) return `${u[0]} and ${u[1]}`;
  if (u.length === 3) return `${u[0]}, ${u[1]} and ${u[2]}`;
  return `${u[0]}, ${u[1]} and ${u.length - 2} others`;
}

/** What a refusal calls the page: "Finance pages", or the card's own title. */
function refusalWhat(t: HubLinkTarget, title: string): string {
  return t.kind === "page" ? `${title} pages` : `“${title}”`;
}

/** Who in this conversation can't open this page (stops at the first few). */
async function blockedReaders(readers: CurrentUser[], t: HubLinkTarget, cache?: Map<string, boolean>): Promise<CurrentUser[]> {
  const out: CurrentUser[] = [];
  for (const v of readers) {
    const key = `${v.id}|${hubLinkKey(t)}`;
    let ok = cache?.get(key);
    if (ok === undefined) {
      ok = await canOpenHubLink(v, t).catch(() => false);
      cache?.set(key, ok);
    }
    if (!ok) out.push(v);
  }
  return out;
}

export type HubLinkCheck = { ok: true; refs: HubLinkRef[] } | { ok: false; message: string };

/** THE SEND-TIME CHECK. Every link must open for every reader of the
 *  conversation; the first that doesn't is refused by name. Titles are
 *  rebuilt here from the records, whatever the composer sent. */
export async function checkHubLinks(c: ConversationRef, targets: HubLinkTarget[]): Promise<HubLinkCheck> {
  const seen = new Set<string>();
  const list = targets.filter((t) => {
    const k = hubLinkKey(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (list.length === 0) return { ok: true, refs: [] };
  if (list.length > MAX_LINKS_PER_MESSAGE) return { ok: false, message: `Add up to ${MAX_LINKS_PER_MESSAGE} pages to one message.` };
  const readers = await conversationReaders(c);
  const refs: HubLinkRef[] = [];
  for (const t of list) {
    const title = await hubLinkTitle(t).catch(() => null);
    if (!title) return { ok: false, message: "One of those pages no longer exists. Remove it to send." };
    const blocked = await blockedReaders(readers, t);
    if (blocked.length > 0) {
      return { ok: false, message: `${namesLine(blocked.map(firstNameOf))} can't open ${refusalWhat(t, title)}. Remove that page to send.` };
    }
    refs.push({ kind: t.kind, id: t.id, ...(t.cut ? { cut: t.cut } : {}), title });
  }
  return { ok: true, refs };
}

/** THE RENDER-TIME CHECK: each link as this viewer sees it. A page they can't
 *  open (permissions changed since it was sent) keeps its title, loses its link. */
export async function hubLinkViews(refs: HubLinkRef[], viewer: CurrentUser | null, cache = new Map<string, boolean>()): Promise<HubLinkView[]> {
  const out: HubLinkView[] = [];
  for (const r of refs) {
    let ok: boolean;
    if (!viewer) ok = !authEnforced();
    else {
      const key = `${viewer.id}|${hubLinkKey(r)}`;
      const hit = cache.get(key);
      ok = hit ?? (await canOpenHubLink(viewer, r).catch(() => false));
      cache.set(key, ok);
    }
    out.push({ title: r.title, href: ok ? hubLinkPath(r) : null, kind: r.kind });
  }
  return out;
}

export type ShareableOffer = HubLinkRef & { href: string; group: string };
export type ShareableSearch = { offered: ShareableOffer[]; hidden: { title: string; why: string }[]; readers: number };

/** THE PICKER: pages matching `q` (an address, a client's name, a menu page's
 *  name), split into the ones every reader can open and the ones someone can't. */
export async function searchShareableLinks(c: ConversationRef, q: string): Promise<ShareableSearch> {
  const term = q.trim().slice(0, 80);
  const readers = await conversationReaders(c);
  const cache = new Map<string, boolean>();
  const candidates: { t: HubLinkTarget; group: string }[] = [];

  const jobTargets = async (projectId: string, group: string, withCuts: boolean) => {
    const [p, photoJob] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId }, select: { id: true, clientId: true } }),
      prisma.photoJob.findUnique({ where: { projectId }, select: { id: true } }).catch(() => null),
    ]);
    if (!p) return;
    for (const kind of ["project", "edit", "shoot", "review", "upload"] as const) candidates.push({ t: { kind, id: p.id }, group });
    if (withCuts) {
      const cuts = await prisma.reviewSubmission.findMany({
        where: { projectId: p.id, status: { in: ["PENDING", "CHANGES_REQUESTED", "APPROVED"] } },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { id: true },
      });
      for (const cut of cuts) candidates.push({ t: { kind: "review", id: p.id, cut: cut.id }, group });
    }
    if (photoJob) candidates.push({ t: { kind: "photos", id: photoJob.id }, group });
    candidates.push({ t: { kind: "client", id: p.clientId }, group });
  };

  // This job's own pages first, in its own thread.
  if (c.kind === "project") await jobTargets(c.projectId, "This job", true);
  if (term.length >= 2) {
    const projects = await prisma.project.findMany({
      where: {
        aryeoMissingAt: null,
        ...(c.kind === "project" ? { id: { not: c.projectId } } : {}),
        OR: [
          { addressLine: { contains: term, mode: "insensitive" } },
          { title: { contains: term, mode: "insensitive" } },
          { client: { name: { contains: term, mode: "insensitive" } } },
        ],
      },
      orderBy: [{ shootDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 5,
      select: { id: true },
    });
    for (const p of projects) await jobTargets(p.id, "Jobs", false);
    const clients = await prisma.client.findMany({
      where: { name: { contains: term, mode: "insensitive" } },
      orderBy: { name: "asc" },
      take: 3,
      select: { id: true },
    });
    for (const cl of clients) candidates.push({ t: { kind: "client", id: cl.id }, group: "Clients" });
  }
  for (const p of PAGES) {
    if (!term || p.label.toLowerCase().includes(term.toLowerCase())) candidates.push({ t: { kind: "page", id: p.key }, group: "Menu pages" });
  }

  const offered: ShareableOffer[] = [];
  const hidden: ShareableSearch["hidden"] = [];
  const seen = new Set<string>();
  for (const { t, group } of candidates.slice(0, 60)) {
    const k = hubLinkKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    const title = await hubLinkTitle(t).catch(() => null);
    if (!title) continue;
    const blocked = await blockedReaders(readers, t, cache);
    if (blocked.length === 0) offered.push({ ...t, title, href: hubLinkPath(t), group });
    else if (t.kind !== "page" || term) hidden.push({ title, why: `${namesLine(blocked.map(firstNameOf))} can't open it` });
  }
  return { offered: offered.slice(0, 30), hidden: hidden.slice(0, 12), readers: readers.length };
}
