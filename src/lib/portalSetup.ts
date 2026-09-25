import "server-only";
import { prisma } from "@/lib/prisma";
import { lockAdvisory } from "@/lib/dbLocks";
import { can, refusalMessage } from "@/lib/portalAccess";
import type { PortalViewer } from "@/lib/portal";
import { isClearedVersion } from "@/lib/clientAssets";

// ---------------------------------------------------------------------------
// ACCOUNT SETUP — the client's checklist (CP-06, Sep 24 2026).
//
// The rule the audit set: skippable, persistent, TRUTHFUL. So completion is
// never stored. Every item is DERIVED from the data it is about — a logo is
// done when an active logo file is on the profile, not when somebody ticked
// "logo" — and the only thing kept is what the client chose to skip for now
// (ContentEnrollment.setupStateJson {skipped:{[key]:iso}}). A skipped item is
// still not done; it just stops being pushed at them on Home. Upload the logo
// later and the item is done whether or not it was ever skipped.
//
// The same derivation feeds the staff onboarding record's asset checklist
// (programOnboarding.ts), so the office and the client cannot disagree about
// what is on file.
// ---------------------------------------------------------------------------

export const SETUP_ITEMS = [
  { key: "colors", label: "Add your brand colors", optional: false },
  { key: "logo", label: "Upload your logo", optional: false },
  { key: "headshot", label: "Upload a headshot", optional: false },
  { key: "fonts", label: "Tell us your fonts", optional: false },
  { key: "links", label: "Add your website or social links", optional: false },
  { key: "music", label: "Pick a music style", optional: false },
  { key: "style", label: "Describe your video style", optional: false },
  { key: "team", label: "Add an assistant or teammate", optional: true },
] as const;
export type SetupKey = (typeof SETUP_ITEMS)[number]["key"];
export const isSetupKey = (k: unknown): k is SetupKey => SETUP_ITEMS.some((i) => i.key === k);

export type SetupItem = {
  key: SetupKey; label: string; done: boolean; optional: boolean;
  /** When the client skipped it; null if they have not (or it is done). */
  skippedAtISO: string | null;
  /** Where to do it: a Brand Profile section, or Settings for the team. The
   *  page builds the link (it knows the query that must survive, e.g. `e=`). */
  tab: "profile" | "settings";
  anchor: string;
};
export type SetupChecklist = {
  items: SetupItem[];
  /** Required items only — an optional one never holds the count back. */
  done: number; total: number; skipped: number;
  complete: boolean;
};

type SetupState = { skipped: Record<string, string> };
function parseState(json: string | null | undefined): SetupState {
  try {
    const v = JSON.parse(json ?? "") as { skipped?: unknown };
    const skipped = v && typeof v.skipped === "object" && v.skipped && !Array.isArray(v.skipped) ? (v.skipped as Record<string, unknown>) : {};
    return { skipped: Object.fromEntries(Object.entries(skipped).filter(([, at]) => typeof at === "string")) as Record<string, string> };
  } catch {
    return { skipped: {} };
  }
}

/** What is actually on file for this client — the facts every item is derived from. */
export async function setupFacts(enrollmentId: string, clientId: string): Promise<Record<Exclude<SetupKey, "team">, boolean> & { teammates: boolean }> {
  const [client, assets, owed, seats] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { brandColors: true, portalVideoStyle: true } }),
    prisma.clientAsset.findMany({ where: { clientId, status: "ACTIVE" }, select: { type: true, profileKey: true, activeVersionId: true } }),
    prisma.appSetting.count({ where: { key: { startsWith: `portal-access-owed:${enrollmentId}:` }, value: { contains: "\"reason\":\"teammate\"" } } }),
    prisma.clientMembership.count({ where: { enrollmentId, revokedAt: null } }),
  ]);
  const ids = assets.map((a) => a.activeVersionId).filter((x): x is string => !!x);
  const versions = ids.length ? await prisma.clientAssetVersion.findMany({ where: { id: { in: ids } }, select: { id: true, fileRef: true, valueText: true, valueJson: true } }) : [];
  const live = assets
    .map((a) => ({ ...a, v: versions.find((x) => x.id === a.activeVersionId) }))
    .filter((a) => a.v && !isClearedVersion(a.v));
  const hasFile = (type: string) => live.some((a) => a.type === type && !a.profileKey && !!a.v?.fileRef);
  const slot = (key: string) => live.some((a) => a.profileKey === key && !!a.v?.valueText?.trim());
  return {
    colors: /#[0-9a-fA-F]{3,6}\b/.test(client?.brandColors ?? ""),
    logo: hasFile("LOGO"),
    headshot: hasFile("HEADSHOT"),
    fonts: slot("fonts") || hasFile("FONT"),
    links: slot("website") || slot("social"),
    music: slot("music"),
    style: !!client?.portalVideoStyle?.trim(),
    // Another live seat, or one the client added that is held until invitations open.
    teammates: seats > 1 || owed > 0,
  };
}

/**
 * The checklist as THIS viewer sees it. The team item appears only for someone who may manage the team.
 *
 * A LOGO ALREADY IN THEIR FOLDER (review, Sep 24 2026). Only a filed asset
 * makes the logo or headshot item done — that is the truth the editor's brief
 * reads — but before CP-06 portal uploads were never filed, so a client whose
 * logo sits in their brand folder was told to "Upload your logo" and re-uploaded
 * it as a duplicate. When the folder holds files nothing on the profile points
 * at, those items ask the useful thing instead — "Tell us which file is your
 * logo" — and link to the folder list, where one tap files it
 * (brandProfile.claimFolderFileForPortal). One folder listing, and only while
 * one of the two is missing; `folder: false` skips it.
 */
export async function setupChecklist(viewer: PortalViewer, opts: { folder?: boolean } = {}): Promise<SetupChecklist> {
  const { enrollment } = viewer;
  const [facts, row] = await Promise.all([
    setupFacts(enrollment.id, enrollment.clientId),
    prisma.contentEnrollment.findUnique({ where: { id: enrollment.id }, select: { setupStateJson: true } }),
  ]);
  const state = parseState(row?.setupStateJson);
  const showTeam = can(viewer, "manageTeam");
  const unfiled = (!facts.logo || !facts.headshot) && opts.folder !== false
    ? await import("@/lib/brandProfile").then((m) => m.unfiledFolderFiles(enrollment.clientId)).catch(() => null)
    : null;
  const inFolder = !!unfiled && unfiled.length > 0;
  const items: SetupItem[] = SETUP_ITEMS.filter((i) => i.key !== "team" || showTeam).map((i) => {
    const done = i.key === "team" ? facts.teammates : facts[i.key];
    const pick = !done && inFolder && (i.key === "logo" || i.key === "headshot");
    return {
      key: i.key, label: pick ? `Tell us which file is your ${i.key === "logo" ? "logo" : "headshot"}` : i.label, done, optional: i.optional,
      skippedAtISO: done ? null : state.skipped[i.key] ?? null,
      tab: i.key === "team" ? "settings" : "profile", anchor: pick ? "files" : i.key,
    };
  });
  const required = items.filter((i) => !i.optional);
  const done = required.filter((i) => i.done).length;
  return { items, done, total: required.length, skipped: items.filter((i) => !i.done && i.skippedAtISO).length, complete: done === required.length };
}

/** "Skip for now" (or bring it back). Never marks anything done. */
export async function skipSetupItem(viewer: PortalViewer, key: string, skip: boolean): Promise<{ ok: boolean; message: string }> {
  if (!can(viewer, "editBrandProfile")) return { ok: false, message: refusalMessage(viewer, "editBrandProfile") };
  if (!isSetupKey(key)) return { ok: false, message: "That isn't one of the setup steps." };
  await prisma.$transaction(async (tx) => {
    // Two tabs skipping two different items must not lose one of them.
    await lockAdvisory(tx, `setup-state|${viewer.enrollment.id}`);
    const row = await tx.contentEnrollment.findUnique({ where: { id: viewer.enrollment.id }, select: { setupStateJson: true } });
    const state = parseState(row?.setupStateJson);
    if (skip) state.skipped[key] = state.skipped[key] ?? new Date().toISOString();
    else delete state.skipped[key];
    await tx.contentEnrollment.update({ where: { id: viewer.enrollment.id }, data: { setupStateJson: JSON.stringify(state) } });
  });
  return { ok: true, message: skip ? "Skipped for now — it stays on your list, and you can do it any time." : "Back on your list." };
}
