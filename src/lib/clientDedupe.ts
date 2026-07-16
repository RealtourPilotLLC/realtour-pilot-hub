import "server-only";
import { prisma } from "@/lib/prisma";
import { phoneKey } from "@/lib/integrations/openphone";

// ---------------------------------------------------------------------------
// Duplicate-contact merge rule. Two clients are the same contact when:
//   • their phone numbers match (last-10 digits) — strongest signal, OR
//   • their NAME and COMPANY/team both match (so two different agents who only
//     share a brokerage are NOT collapsed together).
// On merge: the surviving email is the one with the MOST projects delivered to
// it (priority email); any other email is kept as backupEmail. All projects,
// tasks, and contacts are re-pointed to the survivor; empty survivor fields are
// backfilled from the losers; then the duplicate rows are deleted.
// ---------------------------------------------------------------------------

type DedupeClient = {
  id: string;
  name: string;
  email: string | null;
  backupEmail: string | null;
  phone: string | null;
  company: string | null;
  licenseNumber: string | null;
  generalNotes: string | null;
  editingPreferences: string | null;
  clientPreferences: string | null;
  brandColors: string | null;
  brandAssetsPath: string | null;
  socialClient: boolean;
  socialPlan: string | null;
  aryeoCustomerId: string | null;
  updatedAt: Date;
  _count: { projects: number };
};

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Group duplicate clients with a tiny union-find over phone + name|company keys.
function buildClusters(clients: DedupeClient[]): DedupeClient[][] {
  const parent = new Map<string, string>();
  clients.forEach((c) => parent.set(c.id, c.id));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const nx = parent.get(x)!;
      parent.set(x, r);
      x = nx;
    }
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  const byPhone = new Map<string, string>();
  const byNameCo = new Map<string, string>();
  for (const c of clients) {
    const pk = phoneKey(c.phone);
    if (pk.length === 10) {
      const prev = byPhone.get(pk);
      if (prev) union(prev, c.id);
      else byPhone.set(pk, c.id);
    }
    const name = norm(c.name);
    const co = norm(c.company);
    if (name && co) {
      const k = `${name}|${co}`;
      const prev = byNameCo.get(k);
      if (prev) union(prev, c.id);
      else byNameCo.set(k, c.id);
    }
  }

  const groups = new Map<string, DedupeClient[]>();
  for (const c of clients) {
    const r = find(c.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(c);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export type MergePreview = {
  survivor: string;
  priorityEmail: string | null;
  backupEmail: string | null;
  mergedNames: string[];
  totalProjects: number;
};

export async function dedupeClients(
  opts: { dryRun?: boolean } = {},
): Promise<{ clustersFound: number; clientsMerged: number; previews: MergePreview[] }> {
  const select = {
    id: true, name: true, email: true, backupEmail: true, phone: true, company: true,
    licenseNumber: true, generalNotes: true, editingPreferences: true, clientPreferences: true,
    brandColors: true, brandAssetsPath: true, socialClient: true, socialPlan: true,
    aryeoCustomerId: true, updatedAt: true,
    _count: { select: { projects: true } },
  } as const;

  const clients = (await prisma.client.findMany({ select })) as DedupeClient[];
  const clusters = buildClusters(clients);

  const previews: MergePreview[] = [];
  let clientsMerged = 0;

  for (const cluster of clusters) {
    // Survivor = most projects, tie-break by most recently updated.
    const sorted = [...cluster].sort(
      (a, b) => b._count.projects - a._count.projects || b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    const survivor = sorted[0];
    const losers = sorted.slice(1);

    // Priority email = the email with the most projects; backup = next distinct.
    const ranked = sorted.filter((c) => norm(c.email));
    const priorityEmail = ranked[0]?.email ?? survivor.email ?? null;
    const backupEmail =
      ranked.map((c) => c.email).find((e) => norm(e) && norm(e) !== norm(priorityEmail)) ??
      survivor.backupEmail ??
      null;

    previews.push({
      survivor: survivor.name,
      priorityEmail,
      backupEmail,
      mergedNames: losers.map((l) => l.name),
      totalProjects: cluster.reduce((s, c) => s + c._count.projects, 0),
    });

    if (opts.dryRun) continue;

    // Backfill empty survivor fields from the losers (first non-empty wins).
    const pick = <K extends keyof DedupeClient>(key: K): DedupeClient[K] => {
      if (survivor[key]) return survivor[key];
      for (const l of losers) if (l[key]) return l[key];
      return survivor[key];
    };
    const mergedData = {
      email: priorityEmail,
      backupEmail,
      phone: pick("phone"),
      company: pick("company"),
      licenseNumber: pick("licenseNumber"),
      generalNotes: pick("generalNotes"),
      editingPreferences: pick("editingPreferences"),
      clientPreferences: pick("clientPreferences"),
      brandColors: pick("brandColors"),
      brandAssetsPath: pick("brandAssetsPath"),
      socialClient: survivor.socialClient || losers.some((l) => l.socialClient),
      socialPlan: pick("socialPlan"),
      aryeoCustomerId: pick("aryeoCustomerId"),
    };

    const loserIds = losers.map((l) => l.id);
    await prisma.$transaction(async (tx) => {
      // Re-point all children to the survivor — including comms memory and the
      // assistant→agent folding, which the original merge missed (a merged-away
      // twin referenced as someone's parentClientId orphaned that folding).
      await tx.project.updateMany({ where: { clientId: { in: loserIds } }, data: { clientId: survivor.id } });
      await tx.smartTask.updateMany({ where: { clientId: { in: loserIds } }, data: { clientId: survivor.id } });
      await tx.contact.updateMany({ where: { clientId: { in: loserIds } }, data: { clientId: survivor.id } });
      await tx.commLog.updateMany({ where: { clientId: { in: loserIds } }, data: { clientId: survivor.id } });
      await tx.client.updateMany({ where: { parentClientId: { in: loserIds } }, data: { parentClientId: survivor.id } });
      // Delete the duplicates first so their unique aryeoCustomerId frees up.
      await tx.client.deleteMany({ where: { id: { in: loserIds } } });
      // Then apply the merged record to the survivor.
      await tx.client.update({ where: { id: survivor.id }, data: mergedData });
    });
    clientsMerged += losers.length;
  }

  return { clustersFound: clusters.length, clientsMerged, previews };
}

/**
 * Merge a SPECIFIC set of client rows the automatic rule can't safely infer
 * (same person under a team inbox / a second brokerage email — verified by a
 * human or an audit). Reuses the cluster-merge semantics: survivor = most
 * projects, priority email = the one with the most projects behind it.
 */
export async function mergeClientsById(ids: string[]): Promise<{ ok: boolean; survivor?: string; message?: string }> {
  if (ids.length < 2) return { ok: false, message: "Need at least two clients to merge." };
  const select = {
    id: true, name: true, email: true, backupEmail: true, phone: true, company: true,
    licenseNumber: true, generalNotes: true, editingPreferences: true, clientPreferences: true,
    brandColors: true, brandAssetsPath: true, socialClient: true, socialPlan: true,
    aryeoCustomerId: true, updatedAt: true,
    _count: { select: { projects: true } },
  } as const;
  const cluster = (await prisma.client.findMany({ where: { id: { in: ids } }, select })) as DedupeClient[];
  if (cluster.length !== ids.length) return { ok: false, message: "Some of those clients no longer exist." };

  const sorted = [...cluster].sort(
    (a, b) => b._count.projects - a._count.projects || b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
  const survivor = sorted[0];
  const losers = sorted.slice(1);
  const ranked = sorted.filter((c) => norm(c.email));
  const priorityEmail = ranked[0]?.email ?? survivor.email ?? null;
  const backupEmail =
    ranked.map((c) => c.email).find((e) => norm(e) && norm(e) !== norm(priorityEmail)) ?? survivor.backupEmail ?? null;
  const pick = <K extends keyof DedupeClient>(key: K): DedupeClient[K] => {
    if (survivor[key]) return survivor[key];
    for (const l of losers) if (l[key]) return l[key];
    return survivor[key];
  };
  const loserIds = losers.map((l) => l.id);
  await prisma.$transaction(async (tx) => {
    await tx.project.updateMany({ where: { clientId: { in: loserIds } }, data: { clientId: survivor.id } });
    await tx.smartTask.updateMany({ where: { clientId: { in: loserIds } }, data: { clientId: survivor.id } });
    await tx.contact.updateMany({ where: { clientId: { in: loserIds } }, data: { clientId: survivor.id } });
    await tx.commLog.updateMany({ where: { clientId: { in: loserIds } }, data: { clientId: survivor.id } });
    await tx.client.updateMany({ where: { parentClientId: { in: loserIds } }, data: { parentClientId: survivor.id } });
    await tx.client.deleteMany({ where: { id: { in: loserIds } } });
    await tx.client.update({
      where: { id: survivor.id },
      data: {
        email: priorityEmail,
        backupEmail,
        phone: pick("phone"),
        company: pick("company"),
        licenseNumber: pick("licenseNumber"),
        generalNotes: pick("generalNotes"),
        editingPreferences: pick("editingPreferences"),
        clientPreferences: pick("clientPreferences"),
        brandColors: pick("brandColors"),
        brandAssetsPath: pick("brandAssetsPath"),
        socialClient: survivor.socialClient || losers.some((l) => l.socialClient),
        socialPlan: pick("socialPlan"),
        aryeoCustomerId: pick("aryeoCustomerId"),
      },
    });
  });
  return { ok: true, survivor: survivor.id };
}
