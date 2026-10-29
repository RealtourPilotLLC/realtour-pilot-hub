import { PAGES, type PageKey } from "@/lib/auth/access";

// ---------------------------------------------------------------------------
// HUB PAGES IN A MESSAGE (Jordan, Oct 28 2026: "let users add hub pages to
// messages so that when you send a message, it links to a hub job, note,
// editor brief, or whatever we choose. Obviously, if it links to something,
// the people receiving it would have to be authorized to view it, so only
// pages that are authorized for everyone should be shareable").
//
// What a link IS, in plain data: a kind, the record it opens and (for a Review
// Room cut) which cut. The title is written once, on send, from the hub's own
// records (an address and a page name, never an amount). Who may attach it and
// who may open it is the server's question (lib/hubLinkAccess). Plain module so
// the composer can read a pasted URL before asking the server.
// ---------------------------------------------------------------------------

export type HubLinkKind = "project" | "edit" | "shoot" | "review" | "photos" | "client" | "upload" | "page";

/** A page to link: a record and the screen that opens it. `id` is a PageKey for a menu page. */
export type HubLinkTarget = { kind: HubLinkKind; id: string; cut?: string | null };

/** A link as stored on a message. */
export type HubLinkRef = HubLinkTarget & { title: string };

/** A link as one viewer sees it: no href when they can't open it (any more). */
export type HubLinkView = { title: string; href: string | null; kind: HubLinkKind };

export const MAX_LINKS_PER_MESSAGE = 5;

/** The screen's name, after the address on a card ("825 State St · Editor brief"). */
export const HUB_LINK_LABEL: Record<Exclude<HubLinkKind, "page">, string> = {
  project: "Job file",
  edit: "Editor brief",
  shoot: "Shoot screen",
  review: "Video review",
  photos: "Photo delivery",
  client: "Client file",
  upload: "Upload page",
};

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function hubLinkPath(t: HubLinkTarget): string {
  const id = encodeURIComponent(t.id);
  switch (t.kind) {
    case "project": return `/projects/${id}`;
    case "edit": return `/edit/${id}`;
    case "shoot": return `/shoot/${id}`;
    case "review": return t.cut ? `/review/${id}?cut=${encodeURIComponent(t.cut)}` : `/review/${id}`;
    case "photos": return `/ops/photo-delivery/${id}`;
    case "client": return `/clients/${id}`;
    case "upload": return `/upload/${id}`;
    case "page": return PAGES.find((p) => p.key === t.id)?.href ?? "/";
  }
}

/** The same page, whatever else a pasted URL carried (two links to one page are one link). */
export const hubLinkKey = (t: HubLinkTarget) => `${t.kind}:${t.id}:${t.cut ?? ""}`;

const OWN_HOST = /^(hub\.realtourpilot\.com|localhost(:\d+)?|127\.0\.0\.1(:\d+)?|[a-z0-9-]+\.vercel\.app)$/i;

const NOT_A_HUB_LINK = "Paste a link to a hub page, like hub.realtourpilot.com/edit/…";
const NOT_LINKABLE =
  "That page can't be added to a message yet. A job file, editor brief, shoot screen, video review, photo delivery, client file, upload page or a menu page can.";

/** A pasted URL or path, read as a hub page; `error` says why not, in plain words. */
export function parseHubUrl(input: string): HubLinkTarget | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: NOT_A_HUB_LINK };
  let url: URL;
  try {
    url = raw.startsWith("/") ? new URL(raw, "https://hub.realtourpilot.com") : new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { error: NOT_A_HUB_LINK };
  }
  if (!OWN_HOST.test(url.host)) return { error: NOT_A_HUB_LINK };
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const seg = path.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const one = (kind: HubLinkKind, id: string | undefined, extra?: Partial<HubLinkTarget>): HubLinkTarget | { error: string } =>
    id && ID_RE.test(id) ? { kind, id, ...extra } : { error: NOT_LINKABLE };
  if (seg.length === 2) {
    const [head, id] = seg;
    if (head === "projects") return one("project", id);
    if (head === "edit") return one("edit", id);
    if (head === "shoot") return one("shoot", id);
    if (head === "clients") return one("client", id);
    if (head === "upload") return one("upload", id);
    if (head === "review") {
      const cut = url.searchParams.get("cut");
      return one("review", id, cut && ID_RE.test(cut) ? { cut } : {});
    }
  }
  if (seg.length === 3 && seg[0] === "ops" && seg[1] === "photo-delivery") return one("photos", seg[2]);
  const page = PAGES.find((p) => p.href === path);
  if (page) return { kind: "page", id: page.key };
  return { error: NOT_LINKABLE };
}

export const isPageKey = (key: string): key is PageKey => PAGES.some((p) => p.key === key);

/** Link targets as a composer sent them: only well-formed ones survive (the
 *  server then checks each against the conversation's readers). */
export function sanitizeLinkTargets(input: unknown): HubLinkTarget[] {
  if (!Array.isArray(input)) return [];
  const out: HubLinkTarget[] = [];
  for (const x of input.slice(0, 20)) {
    const r = x as Partial<HubLinkTarget> | null;
    if (!r || typeof r.kind !== "string" || typeof r.id !== "string") continue;
    if (!(r.kind in HUB_LINK_LABEL) && r.kind !== "page") continue;
    if (r.kind === "page" ? !isPageKey(r.id) : !ID_RE.test(r.id)) continue;
    out.push({ kind: r.kind as HubLinkKind, id: r.id, ...(r.kind === "review" && typeof r.cut === "string" && ID_RE.test(r.cut) ? { cut: r.cut } : {}) });
  }
  return out;
}

/** The links stored on a message; anything malformed is dropped, never thrown. */
export function parseStoredLinks(json: string | null | undefined): HubLinkRef[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: HubLinkRef[] = [];
    for (const x of arr) {
      const r = x as Partial<HubLinkRef>;
      if (!r || typeof r.kind !== "string" || typeof r.id !== "string" || typeof r.title !== "string") continue;
      if (!(r.kind in HUB_LINK_LABEL) && r.kind !== "page") continue;
      if (r.kind === "page" ? !isPageKey(r.id) : !ID_RE.test(r.id)) continue;
      out.push({ kind: r.kind as HubLinkKind, id: r.id, ...(r.cut && ID_RE.test(r.cut) ? { cut: r.cut } : {}), title: r.title.slice(0, 140) });
    }
    return out.slice(0, MAX_LINKS_PER_MESSAGE);
  } catch {
    return [];
  }
}
