// ---------------------------------------------------------------------------
// WHICH LISTING IMAGE IS WHICH PHOTO (Oct 22 2026, 615 Cliff Ln).
//
// Jordan: "Since we already delivered Alex's exteriors, can we make sure that
// we know which photo is delivered and which one needs to not be delivered
// again and make sure there are no duplicates in Aryeo but also show all the
// pics together in the hub and let us know which ones are already delivered
// and which ones are not?"
//
// A split job's earlier visit is already on the Aryeo listing; the new
// visit's photos are not. A photo already on the listing keeps the status
// ON_LISTING ("Delivered" in the gallery): it stays out of the delivery set,
// the checks and the push, and the delivery check counts it. The sync keeps
// the status (jobs.ts), the push skips anything matched here (aryeoPush.ts),
// and the delivery check looks for any photo on the listing twice
// (delivery.ts). Pure, except the one read at the bottom.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/**
 * An Aryeo listing image's content hash (Aryeo image objects carry no hash
 * or timestamp: the id plus the original URL changes whenever a photo is
 * replaced). The sync, the push and the delivery check all read it this way.
 */
export const listingImageHash = (id: string | null | undefined, url: string) => createHash("sha256").update(`aryeo:${id ?? ""}:${url}`).digest("hex").slice(0, 40);

/** A photo already on the Aryeo listing beside the new visit's delivery: shown as Delivered, never sent again. */
export const ON_LISTING = "ON_LISTING";
/** An open finding on a photo already delivered on the listing is set aside with this (and given back if it joins the delivery again). */
export const ON_LISTING_REASON = "Already delivered on the Aryeo listing";
/** The version recorded when a photo of the new visit is found on the listing under its own file name (Kyle added it by hand): "<label>: DSC07999.jpg". */
export const BY_HAND_LABEL = "On the Aryeo listing, added by hand";

const N_OF_M = /\((\d+) of (\d+)\)\.[a-z0-9]+$/i;

/** A file name without its extension, lower case. */
export const fileStem = (name: string) => name.trim().toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "");

/**
 * Can a listing image's file name be this photo's own file (uploaded to
 * Aryeo by hand)? "DSC07999.jpg" is DSC07999, so is "DSC07999-2.jpg" or
 * "dsc07999 copy.jpeg". Never a name the hub or AutoHDR gave ("<Street> (3 of
 * 23).jpg", "05-Kitchen.jpg"), and only a camera-style name with a number in
 * it, so two different photos are not matched on a short common word. Pure.
 */
export function sameFile(listingName: string, photoName: string): boolean {
  if (N_OF_M.test(listingName) || N_OF_M.test(photoName)) return false;
  const a = fileStem(listingName);
  const b = fileStem(photoName).replace(/ \(\d+\)$/, ""); // the hub's own " (2)" for a repeated name
  if (/^\d{2,3}-[a-z]/.test(a)) return false; // a delivery name ("05-Kitchen")
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 5 || !/\d{3}/.test(short)) return false;
  return long === short || (long.startsWith(short) && /^[^a-z0-9]/.test(long.slice(short.length)));
}

/** A listing image as the matcher reads it (GalleryEntry has these). */
export type ListedImage = { name: string; sourceRef: string | null; contentHash: string };

/**
 * Photos on the listing twice: two images that are the same photo of the
 * hub (`ownerOf` says whose an image is), or two images with the same file
 * name. Pure. Each entry names the images.
 */
export function listingDuplicates(images: ListedImage[], ownerOf: (img: ListedImage) => string | null): { key: string; names: string[] }[] {
  const groups = new Map<string, string[]>();
  const add = (key: string, name: string) => groups.set(key, [...(groups.get(key) ?? []), name]);
  for (const img of images) {
    const owner = ownerOf(img);
    if (owner) add(`photo:${owner}`, img.name);
    add(`name:${img.name.trim().toLowerCase()}`, img.name);
  }
  const out: { key: string; names: string[] }[] = [];
  const seen = new Set<string>();
  for (const [key, names] of groups) {
    if (names.length < 2) continue;
    // The same two images by owner and by name are one duplicate, said once.
    const sig = [...names].sort().join("\n");
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ key, names });
  }
  return out;
}

/** "DSC07999.jpg twice", "A.jpg and B.jpg (the same photo)": for notes and alerts. */
export function duplicateWords(d: { key: string; names: string[] }[]): string {
  return d
    .slice(0, 3)
    .map((x) => (new Set(x.names.map((n) => n.toLowerCase())).size === 1 ? `${x.names[0]} ${x.names.length === 2 ? "twice" : `${x.names.length} times`}` : `${x.names.slice(0, 3).join(" and ")} (the same photo)`))
    .join("; ") + (d.length > 3 ? "; …" : "");
}

/** The ON_LISTING rows of a job, as the push, the delivery check and the gallery read them. */
export type KeptOnListing = { id: string; name: string; sourceKind: string; sourceRef: string | null; autohdrImageUuid: string | null; hashes: string[]; createdAt: Date };

/** A job's photos already on the listing (ON_LISTING), with every content hash each has had. */
export async function keptOnListing(jobId: string): Promise<KeptOnListing[]> {
  const { prisma } = await import("@/lib/prisma");
  const rows = await prisma.photoAsset.findMany({
    where: { jobId, status: ON_LISTING },
    orderBy: { sequence: "asc" },
    select: { id: true, name: true, sourceKind: true, sourceRef: true, autohdrImageUuid: true, contentHash: true, createdAt: true, versions: { select: { contentHash: true } } },
  });
  return rows.map((r) => ({
    id: r.id, name: r.name, sourceKind: r.sourceKind, sourceRef: r.sourceRef, autohdrImageUuid: r.autohdrImageUuid, createdAt: r.createdAt,
    hashes: [...new Set([r.contentHash, ...r.versions.map((v) => v.contentHash)].filter((h): h is string => !!h))],
  }));
}

/** Is this listing image one of the kept photos (by its listing id, or the content hash a version recorded)? */
export function keptOwner(kept: KeptOnListing[], img: ListedImage): KeptOnListing | null {
  return kept.find((k) => (k.sourceKind === "ARYEO" && !!k.sourceRef && k.sourceRef === img.sourceRef) || k.hashes.includes(img.contentHash)) ?? null;
}
