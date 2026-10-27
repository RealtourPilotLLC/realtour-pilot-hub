import { requirePageAccess, authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { canSeePrices } from "@/lib/auth/access";
import { Package, Sun, Plus, Camera, Home, Building2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/utils";
import type { Product } from "@prisma/client";
import type { LucideIcon } from "lucide-react";

export const dynamic = "force-dynamic";

type Variant = { title?: string; price_amount?: number; duration?: number };

function tagsOf(p: Product): string[] {
  if (!p.tags) return [];
  try {
    return JSON.parse(p.tags) as string[];
  } catch {
    return [];
  }
}

// The catalog's fixed sections, in display order.
const SECTIONS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: "Real Estate", label: "Real Estate", icon: Home },
  { key: "STR", label: "STR (AirBnb)", icon: Building2 },
  { key: "JATEAM", label: "JATEAM", icon: Package },
  { key: "Add-ons", label: "Add-on's", icon: Plus },
];

// Place each product into one of the four buckets. Add-ons (by product type) go
// to "Add-on's"; main products go under each of their matching tags, defaulting
// to Real Estate when none of the three brand tags are present.
function bucketsFor(p: Product): string[] {
  if (p.type !== "MAIN") return ["Add-ons"];
  const tags = tagsOf(p);
  const matched = ["Real Estate", "STR", "JATEAM"].filter((t) => tags.includes(t));
  return matched.length ? matched : ["Real Estate"];
}

// One malformed variants row used to throw inside render and take the whole
// catalog down with it (audit G19); a row that won't parse shows no tiers.
function variantsOf(p: Product): Variant[] {
  if (!p.variants) return [];
  try {
    const v = JSON.parse(p.variants) as unknown;
    return Array.isArray(v) ? (v as Variant[]) : [];
  } catch {
    return [];
  }
}

// PRICES SHOW TO THE OWNER AND ADMINS (Jordan, Oct 27 2026: "Admins can see
// prices of services and billing", reversing Oct 21's "no prices in the
// Catalog" for admins). The dollar figures render for a viewer canSeePrices
// allows (OWNER, ADMIN); anyone else a page grant lets in sees the products,
// tiers and badges without them.
function ProductCard({ p, money }: { p: Product; money: boolean }) {
  const variants = variantsOf(p);
  const from = money && p.minPrice != null ? formatMoney(p.minPrice / 100) : null;
  const range = p.minPrice != null && p.maxPrice != null && p.minPrice !== p.maxPrice;

  return (
    <div className="flex flex-col rounded-2xl border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-semibold leading-snug">{p.title}</span>
        <div className="shrink-0 text-right">
          {from && (
            <div className="text-sm font-semibold">
              {range && <span className="text-xs font-normal text-muted">from </span>}
              {from}
            </div>
          )}
          {variants.length > 1 && <div className="text-[10px] text-muted-2">{variants.length} tiers</div>}
        </div>
      </div>

      {(p.isTwilight || !p.active) && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {p.isTwilight && (
            <Badge color="#d97706" soft="#fef3c7">
              <Sun className="mr-0.5 inline size-3" />
              twilight
            </Badge>
          )}
          {!p.active && <Badge soft="var(--surface-2)">inactive</Badge>}
        </div>
      )}

      {variants.length > 1 && (
        <details className="mt-3 border-t pt-2 [&_summary]:list-none">
          <summary className="cursor-pointer text-xs font-medium text-brand">View {variants.length} {money ? "price tiers" : "tiers"}</summary>
          <div className="mt-2 space-y-1">
            {variants.map((v, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-foreground/80">{v.title ?? `Tier ${i + 1}`}</span>
                {money && (
                  <span className="font-medium">
                    {typeof v.price_amount === "number" ? formatMoney(v.price_amount / 100) : "—"}
                  </span>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export default async function CatalogPage() {
  await requirePageAccess("catalog");
  const [products, me] = await Promise.all([
    prisma.product.findMany({ orderBy: [{ title: "asc" }] }),
    getCurrentUser().catch(() => null),
  ]);
  // Connections is owner-only, so only the owner is pointed at it (audit G18).
  const canSync = me ? me.role === "OWNER" : true;
  // The previewed role under "view as", so a preview shows what that person sees.
  const money = me ? canSeePrices(me.role) : !authEnforced();

  // Build the four fixed groups.
  const grouped = new Map<string, Product[]>(SECTIONS.map((s) => [s.key, []]));
  for (const p of products) {
    for (const b of bucketsFor(p)) grouped.get(b)?.push(p);
  }

  return (
    <div>
      <PageHeader title="Service Catalog" subtitle={`${products.length} products & packages synced from Aryeo`} />
      <div className="space-y-8 p-4 sm:p-6">
        {products.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-surface p-8 text-center">
            <Camera className="mx-auto mb-2 size-6 text-muted-2" />
            <p className="text-sm text-muted">
              {canSync ? (
                <>No products yet. Go to <strong>Connections → Aryeo → Sync catalog</strong> to import.</>
              ) : (
                <>No products yet. Ask Jordan to sync the catalog from Aryeo.</>
              )}
            </p>
          </div>
        ) : (
          SECTIONS.map(({ key, label, icon: Icon }) => {
            const items = grouped.get(key) ?? [];
            if (items.length === 0) return null;
            return (
              <section key={key}>
                <div className="mb-3 flex items-center gap-2">
                  <Icon className="size-4 text-brand" />
                  <h2 className="text-sm font-semibold">{label}</h2>
                  <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{items.length}</span>
                </div>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {items.map((p) => (
                    <ProductCard key={`${key}-${p.id}`} p={p} money={money} />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
