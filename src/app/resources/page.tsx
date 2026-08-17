import Link from "next/link";
import {
  Clapperboard,
  ExternalLink,
  Phone,
  Calendar,
  Camera,
  Folder,
  DollarSign,
  CreditCard,
  Image as ImageIcon,
  Sliders,
  BookOpen,
  ClipboardList,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Markdown } from "@/components/ui/Markdown";
import { prisma } from "@/lib/prisma";
import { Aryeo } from "@/lib/integrations/aryeo";
import { getSecret } from "@/lib/integrations/connections";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier } from "@/lib/auth/access";

// Photographers/editors get the CREATIVE cut of this page: no client pricing,
// fee schedules, sales SOPs, or finance tools (QuickBooks/Stripe). Jordan's
// rule — creatives never see client prices — applies to documents too.
const MONEY_RE = /\b(pricing|price|fees?|fee schedule|sales|billing|invoice|payment|payout|finance|financial|quickbooks|stripe|revenue|margin)\b/i;
// Fees hiding in the BODY also disqualify a doc — the audit found client fees
// inside innocently-titled SOPs ("Scheduling & Reschedule Rules" carried
// $150/$125). But a bare dollar amount isn't enough: creative SOPs quote listing
// prices ("hooks for a $500K home"), so the body only disqualifies when a dollar
// figure appears in a doc that ALSO talks fees/charges/billing.
const DOLLAR_RE = /\$\s?\d{2,}/;
const FEE_CONTEXT_RE = /\b(fees?|charge[sd]?|cancellation|reschedul\w*\s+fee|invoice|billing|payment\s+(due|policy|terms)|waive)\b/i;
function creativeSafeSop(s: { title: string; category: string; content: string }): boolean {
  if (MONEY_RE.test(s.title) || MONEY_RE.test(s.category)) return false;
  if (/quickbooks|stripe/i.test(s.content)) return false;
  return !(DOLLAR_RE.test(s.content) && FEE_CONTEXT_RE.test(s.content));
}
function creativeSafeResource(r: { title: string; category: string; url: string; description: string | null }): boolean {
  return !MONEY_RE.test(r.title) && !MONEY_RE.test(r.category) && !MONEY_RE.test(r.description ?? "") && !/quickbooks|stripe/i.test(r.url);
}

type OrderForm = { id?: string; title?: string; url?: string; is_public?: boolean };

async function getOrderForms(): Promise<OrderForm[]> {
  if (!(await getSecret("aryeo"))) return [];
  try {
    return (await Aryeo.orderForms()) as OrderForm[];
  } catch {
    return [];
  }
}

export const dynamic = "force-dynamic";

const ICONS: Record<string, LucideIcon> = {
  phone: Phone,
  calendar: Calendar,
  camera: Camera,
  folder: Folder,
  "dollar-sign": DollarSign,
  "credit-card": CreditCard,
  image: ImageIcon,
  sliders: Sliders,
};

function groupBy<T>(items: T[], key: (t: T) => string) {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  }
  return [...map.entries()];
}

export default async function ResourcesPage() {
  const me = await getCurrentUser().catch(() => null);
  const creative = !!me && contentTier(me.role) === "CREATIVE";
  const [allResources, allSops, orderForms] = await Promise.all([
    prisma.resource.findMany({ orderBy: [{ category: "asc" }, { sortOrder: "asc" }] }),
    prisma.sop.findMany({ orderBy: [{ category: "asc" }, { title: "asc" }] }),
    getOrderForms(),
  ]);
  // Creatives get a pure "SOP Center": procedures only — no booking forms, no
  // quick links/tools (those are ops surfaces, not field material).
  const resources = creative ? [] : allResources;
  const sops = creative ? allSops.filter(creativeSafeSop) : allSops;
  const forms = creative ? [] : orderForms;

  const resourceGroups = groupBy(resources, (r) => r.category);
  const sopGroups = groupBy(sops, (s) => s.category);

  return (
    <div>
      <PageHeader
        title={creative ? "SOP Center" : "Resources & SOPs"}
        subtitle={creative ? "How we shoot, edit, and deliver — the standards for every job" : "Links, tools, and standard operating procedures for the team"}
      />
      <div className="space-y-8 p-6">
        {/* Pinned: the Video Style Guide — every role sees this card (it's the
            one reference page the editors live by, and photographers/admin
            benefit from knowing the bar too). */}
        <Link
          href="/resources/video-styles"
          className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4 transition hover:border-brand"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand">
            <Clapperboard className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Video Style Guide</span>
            <span className="block text-xs text-muted">
              Every video type we edit — style specs, linked examples, edit-time budgets and turnarounds
            </span>
          </span>
          <ExternalLink className="size-4 shrink-0 text-muted-2" />
        </Link>

        {/* Booking forms (live from Aryeo) */}
        {forms.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <ClipboardList className="size-4 text-brand" />
              <h2 className="text-sm font-semibold text-muted">Booking forms</h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {forms.map((f) => (
                <a
                  key={f.id}
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center justify-between gap-3 rounded-2xl border bg-surface p-4 transition-shadow hover:shadow-md"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 truncate font-medium">
                      <span className="truncate">{f.title}</span>
                      <ExternalLink className="size-3 shrink-0 text-muted-2 opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                    <div className="text-xs text-muted">Client order form</div>
                  </div>
                  {f.is_public ? (
                    <Badge color="#16a34a" soft="#dcfce7">Public</Badge>
                  ) : (
                    <Badge soft="var(--surface-2)">Private</Badge>
                  )}
                </a>
              ))}
            </div>
          </section>
        )}

        {/* Quick links */}
        <section className="space-y-5">
          <h2 className="text-sm font-semibold text-muted">Quick links</h2>
          {resourceGroups.map(([category, items]) => (
            <div key={category}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-2">
                {category}
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((r) => {
                  const Icon = (r.icon && ICONS[r.icon]) || ExternalLink;
                  return (
                    <a
                      key={r.id}
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-center gap-3 rounded-2xl border bg-surface p-4 transition-shadow hover:shadow-md"
                    >
                      <span className="flex size-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
                        <Icon className="size-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1 font-medium">
                          <span className="truncate">{r.title}</span>
                          <ExternalLink className="size-3 shrink-0 text-muted-2 opacity-0 transition-opacity group-hover:opacity-100" />
                        </div>
                        {r.description && (
                          <div className="truncate text-xs text-muted">{r.description}</div>
                        )}
                      </div>
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </section>

        {/* SOP center */}
        <section className="space-y-5">
          <div className="flex items-center gap-2">
            <BookOpen className="size-4 text-brand" />
            <h2 className="text-sm font-semibold text-muted">SOP Center</h2>
          </div>
          {sopGroups.map(([category, items]) => (
            <div key={category}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-2">
                {category}
              </div>
              <div className="space-y-2">
                {items.map((s) => (
                  <details
                    key={s.id}
                    className="group rounded-2xl border bg-surface px-5 py-3.5 [&_summary]:list-none"
                  >
                    <summary className="flex cursor-pointer items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold">{s.title}</div>
                        {s.summary && <div className="text-xs text-muted">{s.summary}</div>}
                      </div>
                      <span className="text-xs text-muted-2 group-open:hidden">Open</span>
                      <span className="hidden text-xs text-muted-2 group-open:inline">Close</span>
                    </summary>
                    <div className="mt-3 border-t pt-3">
                      <Markdown content={s.content} />
                    </div>
                  </details>
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
