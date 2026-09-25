import { prisma } from "@/lib/prisma";
import { customerNote } from "@/lib/clientNotes";
import { BrandAssetsPanel } from "@/components/content/BrandAssetsPanel";
import { ProfileSections } from "@/components/content/Workspace";
import { loadBrandTab } from "../workspaceData";
import type { TabCtx } from "./shared";

// ---------------------------------------------------------------------------
// BRAND (UI-02) — the structured brand profile and assets (fonts, website,
// social, music, logos; with the change history and the editor-facing
// acknowledgements BrandAssetsPanel already carries), and — moved here from the
// old Client file — the agent profile's six sections and the customer note.
// The panel used to show those profile blobs as read-only "sources" while the
// editable copy sat on a different tab; they are now side by side.
// ---------------------------------------------------------------------------

export async function BrandTab({ ctx }: { ctx: TabCtx }) {
  const { id, client } = ctx;
  const [d, profile] = await Promise.all([
    loadBrandTab(client.id),
    prisma.agentProfile.findUnique({ where: { clientId: client.id } }),
  ]);
  return (
    <div className="space-y-5">
      <BrandAssetsPanel enrollmentId={id} clientId={client.id} assets={d.assets} types={d.types} sources={d.sources} provenance={d.provenance} changes={d.changes} canEdit />
      <ProfileSections
        clientId={client.id}
        profile={{
          brandJson: profile?.brandJson ?? null,
          voiceJson: profile?.voiceJson ?? null,
          contentPrefsJson: profile?.contentPrefsJson ?? null,
          productionJson: profile?.productionJson ?? null,
          editingJson: profile?.editingJson ?? null,
          storiesJson: profile?.storiesJson ?? null,
        }}
        customerNote={customerNote(client)}
      />
    </div>
  );
}
