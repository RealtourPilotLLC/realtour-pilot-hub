import { Package, Sun, Plus, Camera } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Variant = { title?: string; price_amount?: number; duration?: number };

// Aryeo product descriptions are HTML — strip tags + decode common entities.
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function CatalogPage() {
  const products = await prisma.product.findMany({
    orderBy: [{ type: "asc" }, { title: "asc" }],
  });

  const main = products.filter((p) => p.type === "MAIN");
  const addons = products.filter((p) => p.type !== "MAIN");

  const Section = ({ title, items, icon: Icon }: { title: string; items: typeof products; icon: typeof Package }) =>
    items.length === 0 ? null : (
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Icon className="size-4 text-brand" />
          <h2 className="text-sm font-semibold">{title}</h2>
          <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{items.length}</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((p) => {
            const variants: Variant[] = p.variants ? JSON.parse(p.variants) : [];
            return (
              <div key={p.id} className="flex flex-col rounded-2xl border bg-surface p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold leading-snug">{p.title}</span>
                  {!p.active && <Badge soft="var(--surface-2)">inactive</Badge>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {p.category && <Badge soft="var(--brand-soft)" color="var(--brand)">{p.category}</Badge>}
                  {p.isTwilight && (
                    <Badge color="#d97706" soft="#fef3c7">
                      <Sun className="mr-0.5 inline size-3" />
                      twilight
                    </Badge>
                  )}
                </div>
                {p.description && (
                  <p className="mt-2 line-clamp-2 text-xs text-muted">{stripHtml(p.description)}</p>
                )}

                <div className="mt-3 text-sm">
                  {p.minPrice != null && (
                    <span className="font-semibold">
                      {p.minPrice === p.maxPrice
                        ? formatMoney(p.minPrice / 100)
                        : `${formatMoney((p.minPrice ?? 0) / 100)} – ${formatMoney((p.maxPrice ?? 0) / 100)}`}
                    </span>
                  )}
                  {variants.length > 1 && (
                    <span className="ml-1 text-xs text-muted">· {variants.length} tiers</span>
                  )}
                </div>

                {variants.length > 0 && (
                  <details className="mt-2 [&_summary]:list-none">
                    <summary className="cursor-pointer text-xs font-medium text-brand">
                      Price tiers
                    </summary>
                    <div className="mt-2 space-y-1 border-t pt-2">
                      {variants.map((v, i) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="text-foreground/80">{v.title ?? `Tier ${i + 1}`}</span>
                          <span className="font-medium">
                            {typeof v.price_amount === "number" ? formatMoney(v.price_amount / 100) : "—"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      </section>
    );

  return (
    <div>
      <PageHeader
        title="Service Catalog"
        subtitle={`${products.length} products & packages synced from Aryeo`}
      />
      <div className="space-y-8 p-6">
        {products.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-surface p-8 text-center">
            <Camera className="mx-auto mb-2 size-6 text-muted-2" />
            <p className="text-sm text-muted">
              No products yet. Go to <strong>Connections → Aryeo → Sync products</strong> to import your catalog.
            </p>
          </div>
        ) : (
          <>
            <Section title="Packages & Services" items={main} icon={Package} />
            <Section title="Add-ons" items={addons} icon={Plus} />
          </>
        )}
      </div>
    </div>
  );
}
