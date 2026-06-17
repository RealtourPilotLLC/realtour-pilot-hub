import Link from "next/link";
import { Package, Sun, Plus, Camera, Tag as TagIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/utils";
import type { Product } from "@prisma/client";

export const dynamic = "force-dynamic";

type Variant = { title?: string; price_amount?: number; duration?: number };
type GroupBy = "type" | "tag" | "category";

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

function tagsOf(p: Product): string[] {
  if (!p.tags) return [];
  try {
    return JSON.parse(p.tags) as string[];
  } catch {
    return [];
  }
}

function ProductCard({ p }: { p: Product }) {
  const variants: Variant[] = p.variants ? JSON.parse(p.variants) : [];
  const tags = tagsOf(p);
  return (
    <div className="flex flex-col rounded-2xl border bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold leading-snug">{p.title}</span>
        {!p.active && <Badge soft="var(--surface-2)">inactive</Badge>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Badge soft="var(--surface-2)">{p.type === "MAIN" ? "Package" : "Add-on"}</Badge>
        {p.isTwilight && (
          <Badge color="#d97706" soft="#fef3c7">
            <Sun className="mr-0.5 inline size-3" />
            twilight
          </Badge>
        )}
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-0.5 rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand"
          >
            <TagIcon className="size-2.5" />
            {t}
          </span>
        ))}
      </div>
      {p.description && <p className="mt-2 line-clamp-2 text-xs text-muted">{stripHtml(p.description)}</p>}

      <div className="mt-3 text-sm">
        {p.minPrice != null && (
          <span className="font-semibold">
            {p.minPrice === p.maxPrice
              ? formatMoney(p.minPrice / 100)
              : `${formatMoney((p.minPrice ?? 0) / 100)} – ${formatMoney((p.maxPrice ?? 0) / 100)}`}
          </span>
        )}
        {variants.length > 1 && <span className="ml-1 text-xs text-muted">· {variants.length} tiers</span>}
      </div>

      {variants.length > 0 && (
        <details className="mt-2 [&_summary]:list-none">
          <summary className="cursor-pointer text-xs font-medium text-brand">Price tiers</summary>
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
}

// Build ordered [groupLabel, products][] for the chosen grouping. A product can
// appear in multiple groups when grouping by tag (multi-tagged).
function buildGroups(products: Product[], groupBy: GroupBy): [string, Product[]][] {
  const map = new Map<string, Product[]>();
  const push = (key: string, p: Product) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(p);
  };

  for (const p of products) {
    if (groupBy === "type") {
      push(p.type === "MAIN" ? "Packages & Services" : "Add-ons", p);
    } else if (groupBy === "category") {
      push(p.category || "Uncategorized", p);
    } else {
      const tags = tagsOf(p);
      if (tags.length === 0) push("Untagged", p);
      else for (const t of tags) push(t, p);
    }
  }

  const entries = [...map.entries()];
  // Keep a sensible order: Packages before Add-ons; otherwise alpha, catch-alls last.
  const catchAll = ["Untagged", "Uncategorized", "Add-ons"];
  entries.sort((a, b) => {
    const ai = catchAll.indexOf(a[0]);
    const bi = catchAll.indexOf(b[0]);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? -1 : ai) - (bi === -1 ? -1 : bi);
    if (a[0] === "Packages & Services") return -1;
    if (b[0] === "Packages & Services") return 1;
    return a[0].localeCompare(b[0]);
  });
  return entries;
}

const GROUP_OPTIONS: { key: GroupBy; label: string }[] = [
  { key: "type", label: "Type" },
  { key: "tag", label: "Tag" },
  { key: "category", label: "Category" },
];

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string }>;
}) {
  const { group } = await searchParams;
  const groupBy: GroupBy = group === "tag" || group === "category" ? group : "type";

  const products = await prisma.product.findMany({ orderBy: [{ type: "asc" }, { title: "asc" }] });
  const groups = buildGroups(products, groupBy);

  return (
    <div>
      <PageHeader
        title="Service Catalog"
        subtitle={`${products.length} products & packages synced from Aryeo`}
        actions={
          <div className="flex items-center gap-1 rounded-lg border bg-surface p-0.5">
            <span className="px-2 text-xs text-muted">Group by</span>
            {GROUP_OPTIONS.map((o) => (
              <Link
                key={o.key}
                href={o.key === "type" ? "/catalog" : `/catalog?group=${o.key}`}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  groupBy === o.key ? "bg-brand text-brand-fg" : "text-foreground/70 hover:bg-surface-2"
                }`}
              >
                {o.label}
              </Link>
            ))}
          </div>
        }
      />
      <div className="space-y-8 p-6">
        {products.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-surface p-8 text-center">
            <Camera className="mx-auto mb-2 size-6 text-muted-2" />
            <p className="text-sm text-muted">
              No products yet. Go to <strong>Connections → Aryeo → Sync catalog</strong> to import.
            </p>
          </div>
        ) : (
          groups.map(([label, items]) => (
            <section key={label}>
              <div className="mb-3 flex items-center gap-2">
                {groupBy === "tag" ? (
                  <TagIcon className="size-4 text-brand" />
                ) : label === "Add-ons" ? (
                  <Plus className="size-4 text-brand" />
                ) : (
                  <Package className="size-4 text-brand" />
                )}
                <h2 className="text-sm font-semibold">{label}</h2>
                <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{items.length}</span>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {items.map((p) => (
                  <ProductCard key={`${label}-${p.id}`} p={p} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
