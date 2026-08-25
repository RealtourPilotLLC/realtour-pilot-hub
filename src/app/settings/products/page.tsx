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
      id: true, title: true, type: true, tags: true, description: true, minPrice: true, maxPrice: true,
      mediaTypes: true, addonTypes: true, videoTier: true, serviceKind: true, aryeoServiceable: true, mappedAt: true, mappedBy: true,
    },
  });

  const cards: ProductCard[] = products.map((p) => {
    let mapped: string[] | null = null;
    try { mapped = p.mediaTypes ? (JSON.parse(p.mediaTypes) as string[]) : null; } catch { mapped = null; }
    // The parser's current opinion — shown as the STARTING point on unmapped
    // cards so Jordan corrects rather than starts from zero.
    const suggestion = (mapped ?? [...new Set(deliverablesForTitle(p.title).map((d) => d.type as string))])
      .map((t) => (t === "DRONE" ? "DRONE_PHOTO" : t)); // UI splits drone into photo/video chips
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
      tags: (() => { try { return p.tags ? (JSON.parse(p.tags) as string[]) : []; } catch { return []; } })(),
      addonTypes: (() => { try { return p.addonTypes ? (JSON.parse(p.addonTypes) as string[]) : []; } catch { return []; } })(),
      videoTier: p.videoTier,
      // Aryeo's own is_serviceable flag seeds the default until a human maps it.
      serviceKind: p.serviceKind ?? (p.aryeoServiceable === false || p.type === "ADDON" ? "addon" : "service"),
      isMapped: mapped !== null,
      mappedBy: p.mappedBy,
    };
  });
  const uses = (c: ProductCard) => usage.get(c.title.toLowerCase().trim()) ?? 0;
  const byUse = (a: ProductCard, b: ProductCard) => uses(b) - uses(a);
  // Jordan's structure: live Aryeo catalog segmented by its own TAGS (Real
  // Estate / STR / team), Main products before Add-ons inside each. Retired
  // titles that still sit on real orders stay reachable, collapsed at the
  // bottom — that path is what fixed Faye's ghost video.
  const live = cards.filter((c) => c.aryeoType !== "LEGACY");
  const legacy = cards.filter((c) => c.aryeoType === "LEGACY").sort(byUse);
  const segmentOf = (c: ProductCard) =>
    c.tags.includes("STR") ? "Short-term rental (STR)"
    : c.tags.includes("Real Estate") ? "Real Estate"
    : c.tags.includes("JATEAM") ? "Jamie Achberger Team"
    : "Other";
  const SEGMENTS = ["Real Estate", "Short-term rental (STR)", "Jamie Achberger Team", "Other"];
  const segments = SEGMENTS.map((name) => {
    const inSeg = live.filter((c) => segmentOf(c) === name);
    return {
      name,
      main: inSeg.filter((c) => c.aryeoType !== "ADDON").sort(byUse),
      addons: inSeg.filter((c) => c.aryeoType === "ADDON").sort(byUse),
    };
  }).filter((g) => g.main.length + g.addons.length > 0);
  const mappedCount = live.filter((c) => c.isMapped).length;

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/settings" label="Settings" />
      </div>
      <PageHeader
        eyebrow="The source of truth for what each product produces"
        title="Product categories"
        subtitle={`Live Aryeo catalog · ${mappedCount} of ${live.length} products mapped by hand — mapped products override every automatic parser, everywhere`}
      />
      <div className="mx-auto max-w-4xl space-y-8 p-4 pb-16 sm:p-6">
        {segments.map((seg) => (
          <section key={seg.name}>
            <h2 className="mb-3 text-base font-semibold">{seg.name}</h2>
            {seg.main.length > 0 && (
              <>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-2">Main products ({seg.main.length})</h3>
                <div className="mb-4 space-y-3">
                  {seg.main.map((c) => <ProductMappingCard key={c.id} card={c} />)}
                </div>
              </>
            )}
            {seg.addons.length > 0 && (
              <>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-2">Add-ons ({seg.addons.length})</h3>
                <div className="space-y-3">
                  {seg.addons.map((c) => <ProductMappingCard key={c.id} card={c} />)}
                </div>
              </>
            )}
          </section>
        ))}
        {legacy.length > 0 && (
          <details className="rounded-2xl border border-dashed border-border p-4">
            <summary className="cursor-pointer text-sm font-medium text-muted">
              Retired &amp; custom order lines ({legacy.length}) — not in the live Aryeo catalog, but still on real orders
            </summary>
            <div className="mt-3 space-y-3">
              {legacy.map((c) => <ProductMappingCard key={c.id} card={c} />)}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
