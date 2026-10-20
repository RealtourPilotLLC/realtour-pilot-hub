import "server-only";

// ---------------------------------------------------------------------------
// IS THE CLIENT'S BRAND KIT ON FILE? (Oct 20 2026). Jordan: "for the editor
// brief, I want to make sure the client's brand assets and brand colors are
// displayed clearly alongside the edit instructions ... If agents have not
// filled it out yet, then send them a message once a week until they do."
//
// What the editor needs from a client is their brand colors and their logo.
// Each counts as on file whichever way it reached us, so nobody is asked for
// something we already have:
//   · colors — on the portal's Brand Profile (portalSetup.setupFacts), in
//     the office's standing note on the client (the Agent Profile's merged
//     style colors, which the editor brief already shows), a COLOR_PALETTE
//     asset, or a palette / brand guide file in their brand folder (Kristin
//     Ciarmella's "Color Palette.png");
//   · logo   — filed on the Brand Profile, or a file named like a logo in
//     their Dropbox brand folder (the brief's own folder-logo rule).
// A read that fails answers null: the reminder then waits, never nags.
// ---------------------------------------------------------------------------

export type BrandKitStatus = { colors: boolean; logo: boolean; missing: string[] };

const WORDS: Record<"colors" | "logo", string> = { logo: "logo", colors: "brand colors" };

export async function brandKitStatus(enrollmentId: string, clientId: string): Promise<BrandKitStatus | null> {
  try {
    const { setupFacts } = await import("@/lib/portalSetup");
    const facts = await setupFacts(enrollmentId, clientId);
    let colors = facts.colors;
    let logo = facts.logo;
    if (!colors) {
      const [{ agentProfileFor }, { prisma }] = await Promise.all([import("@/lib/clientProfile"), import("@/lib/prisma")]);
      const agent = await agentProfileFor(clientId).catch(() => null);
      colors = !!agent?.style.colors.length || (await prisma.clientAsset.count({ where: { clientId, status: "ACTIVE", type: "COLOR_PALETTE" } })) > 0;
    }
    if (!logo || !colors) {
      const [{ listClientAssets }, { prisma }] = await Promise.all([import("@/lib/clientAssets"), import("@/lib/prisma")]);
      const folder = await listClientAssets(clientId, { links: false });
      if (!folder) return null;
      // listClientAssets answers an empty, "not found" folder on a Dropbox
      // hiccup too: a folder ON RECORD that did not read is "we cannot tell".
      if (!folder.folderExists) {
        const c = await prisma.client.findUnique({ where: { id: clientId }, select: { brandAssetsPath: true } });
        if (c?.brandAssetsPath) return null;
      }
      if (!logo) logo = folder.files.some((f) => /logo/i.test(f.name));
      if (!colors) colors = folder.files.some((f) => /palette|colou?rs?\b|brand ?guide|style ?guide/i.test(f.name));
    }
    const missing = (["logo", "colors"] as const).filter((k) => !(k === "logo" ? logo : colors)).map((k) => WORDS[k]);
    return { colors, logo, missing };
  } catch {
    return null;
  }
}
