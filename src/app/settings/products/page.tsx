import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { deliverablesForTitle, loadManualProductMap } from "@/lib/integrations/aryeo";
import { stripHtml } from "@/lib/utils";
import { ProductMappingCard, type ProductCard } from "@/components/settings/ProductMappingCard";

export const dynamic = "force-dynamic";

// Settings → Products: every Aryeo product as a card; a human assigns what it
// ACTUALLY produces (photo/video/both + tier + service-vs-add-on) and the
// whole platform obeys that over any parser (Aug 24: phantom floor plans and
// Faye's ghost video came from descriptions mentioning services nobody
// ordered — Jordan: "instead of relying on AI, set it manually in settings").
export default async function ProductMappingPage() {
  const me = await getCurrentUser().catch(() => null);
  if (authEnforced() && (!me || (me.role !== "OWNER" && me.role !== "ADMIN"))) redirect("/");

  await loadManualProductMap(true);
  // How often each product is actually ordered — the map work queue sorts by
  // real-world impact, not alphabet (206 cards incl. retired products).
  const usage = new Map(
    (await prisma.orderItem.groupBy({ by: ["title"], _count: true })).map((g) => [g.title.toLowerCase().trim(), g._count]),
  );
  const products = await prisma.product.findMany({
    where: { active: true },
    orderBy: [{ title: "asc" }],
    select: {
      id: true, title: true, type: true, description: true, minPrice: true, maxPrice: true,
      mediaTypes: true, videoTier: true, serviceKind: true, mappedAt: true, mappedBy: true,
    },
  });

  const cards: ProductCard[] = products.map((p) => {
    let mapped: string[] | null = null;
    try { mapped = p.mediaTypes ? (JSON.parse(p.mediaTypes) as string[]) : null; } catch { mapped = null; }
    // The parser's current opinion — shown as the STARTING point on unmapped
    // cards so Jordan corrects rather than starts from zero.
    const suggestion = mapped ?? [...new Set(deliverablesForTitle(p.title).map((d) => d.type as string))];
    return {
      id: p.id,
      title: p.title,
      aryeoType: p.type,
      description: p.description ? stripHtml(p.description).replace(/\s+/g, " ").trim() : null,
      orders: usage.get(p.title.toLowerCase().trim()) ?? 0,
      priceRange:
        p.minPrice != null
          ? p.maxPrice != null && p.maxPrice !== p.minPrice
            ? `$${(p.minPrice / 100).toFixed(0)}–$${(p.maxPrice / 100).toFixed(0)}`
            : `$${(p.minPrice / 100).toFixed(0)}`
          : null,
      types: suggestion,
      videoTier: p.videoTier,
      serviceKind: p.serviceKind ?? (p.type === "ADDON" ? "addon" : "service"),
      isMapped: mapped !== null,
      mappedBy: p.mappedBy,
    };
  });
  const uses = (c: ProductCard) => usage.get(c.title.toLowerCase().trim()) ?? 0;
  const unmapped = cards.filter((c) => !c.isMapped).sort((a, b) => uses(b) - uses(a));
  const done = cards.filter((c) => c.isMapped).sort((a, b) => uses(b) - uses(a));

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/settings" label="Settings" />
      </div>
      <PageHeader
        eyebrow="The source of truth for what each product produces"
        title="Product categories"
        subtitle={`${done.length} of ${cards.length} products mapped by hand — mapped products override every automatic parser, everywhere`}
      />
      <div className="mx-auto max-w-4xl space-y-6 p-4 pb-16 sm:p-6">
        {unmapped.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-warning">Not yet mapped — running on the automatic parser ({unmapped.length})</h2>
            <div className="space-y-3">
              {unmapped.map((c) => <ProductMappingCard key={c.id} card={c} />)}
            </div>
          </section>
        )}
        {done.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-success">Mapped — hand-set, authoritative ({done.length})</h2>
            <div className="space-y-3">
              {done.map((c) => <ProductMappingCard key={c.id} card={c} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
