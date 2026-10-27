import { requirePageAccess } from "@/lib/auth/guards";
import Link from "next/link";
import {
  Clapperboard,
  Compass,
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
import { Markdown } from "@/components/ui/Markdown";
import { prisma } from "@/lib/prisma";
import { Aryeo } from "@/lib/integrations/aryeo";
import { getSecret } from "@/lib/integrations/connections";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier } from "@/lib/auth/access";
import { GUIDES, guideForRole } from "./guide/content";
import { ResourceSearch } from "./ResourceSearch";
import { RESOURCE_TOPICS, resourceTopicOf, type ResourceTopic } from "./topics";

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

/** What the search box reads for one item: its words, lower-cased, an SOP's body capped. */
const searchText = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" ").replace(/\s+/g, " ").toLowerCase().slice(0, 6000);

export default async function ResourcesPage() {
  await requirePageAccess("resources");
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

  // The walkthrough card names the guide this person will actually land on.
  const guideTitle = GUIDES[guideForRole(me?.role)].title;

  // BY WHO USES THEM (Jordan, Oct 27 2026: "it could be organized a little
  // better"). One section per topic (./topics), the links first and then the
  // procedures, each with its typed category as a small label; the booking
  // forms sit with the office's topic. A topic with nothing in it is not drawn,
  // and the search box above them hides what does not match.
  const byTopic = (k: ResourceTopic) => ({
    links: resources.filter((r) => resourceTopicOf(r.category) === k),
    sops: sops.filter((x) => resourceTopicOf(x.category) === k),
    forms: k === "office" ? forms : [],
  });
  const topics = RESOURCE_TOPICS.map((t) => ({ ...t, ...byTopic(t.key) })).filter((t) => t.links.length + t.sops.length + t.forms.length > 0);

  return (
    <div>
      <PageHeader
        title={creative ? "SOP Center" : "Resources & SOPs"}
        subtitle={creative ? "How we shoot, edit and deliver: the standards for every job" : "Links, tools and how we do things, grouped by who uses them"}
      />
      <div className="mx-auto max-w-5xl space-y-8 p-4 pb-16 sm:p-6">
        {/* Start here: this person's own walkthrough guide (go-live, Sep 2026;
            /resources/guide lands each role on theirs) and the Video Style
            Guide every role reads. Always shown, above the search. */}
        <section aria-labelledby="start-here" className="space-y-3">
          <h2 id="start-here" className="text-base font-semibold">Start here</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Link
              href="/resources/guide"
              className="flex items-center gap-3 rounded-2xl border border-brand/40 bg-brand/[0.04] p-4 transition hover:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand">
                <Compass className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{guideTitle}: how the hub works</span>
                <span className="block text-sm leading-relaxed text-muted">Your day in order, then every screen you use</span>
              </span>
            </Link>
            <Link
              href="/resources/video-styles"
              className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4 transition hover:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand">
                <Clapperboard className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">Video Style Guide</span>
                <span className="block text-sm leading-relaxed text-muted">Every video type we edit: specs, examples, edit time and turnaround</span>
              </span>
            </Link>
            {/* Service Catalog lives here: a static price reference whose own nav door went unopened (audit). */}
            {!creative && (
              <Link
                href="/catalog"
                className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4 transition hover:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand md:col-span-2"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                  <BookOpen className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">Service Catalog</span>
                  <span className="block text-sm leading-relaxed text-muted">Every product, price and description</span>
                </span>
              </Link>
            )}
          </div>
        </section>

        <ResourceSearch label={creative ? "Search the SOPs" : "Search resources and SOPs"}>
          {topics.length === 0 && <p className="text-sm text-muted">Nothing has been added here yet.</p>}
          {topics.map((t) => (
            <section key={t.key} aria-labelledby={`topic-${t.key}`} data-search-group={t.key} data-topic={t.key} className="space-y-3">
              <div>
                <h2 id={`topic-${t.key}`} className="text-base font-semibold">{t.title}</h2>
                {t.blurb && <p className="text-sm text-muted">{t.blurb}</p>}
              </div>

              {/* Booking forms, live from Aryeo (the office's topic). */}
              {t.forms.length > 0 && (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {t.forms.map((f) => (
                    <a
                      key={f.id}
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-search={searchText(f.title, "booking form client order form")}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-sm font-medium"><ClipboardList aria-hidden className="size-4 shrink-0 text-brand" /> {f.title}</span>
                        <span className="block text-xs text-muted">Client booking form{f.is_public ? ", public" : ", private"}</span>
                      </span>
                      <ExternalLink aria-hidden className="size-4 shrink-0 text-muted-2" />
                    </a>
                  ))}
                </div>
              )}

              {t.links.length > 0 && (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {t.links.map((r) => {
                    const Icon = (r.icon && ICONS[r.icon]) || ExternalLink;
                    return (
                      <a
                        key={r.id}
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-search={searchText(r.title, r.description, r.category)}
                        className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                          <Icon aria-hidden className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{r.title}</span>
                          {r.description && <span className="block text-xs leading-relaxed text-muted">{r.description}</span>}
                        </span>
                        <ExternalLink aria-hidden className="size-4 shrink-0 text-muted-2" />
                      </a>
                    );
                  })}
                </div>
              )}

              {t.sops.length > 0 && (
                <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
                  {t.sops.map((x) => (
                    <details key={x.id} data-search={searchText(x.title, x.summary, x.category, x.content)} className="group px-4 py-1 [&_summary]:list-none">
                      <summary className="flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-lg py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold">{x.title}</span>
                          {x.summary && <span className="block text-sm leading-relaxed text-muted">{x.summary}</span>}
                          <span className="block text-xs text-muted-2">{x.category}</span>
                        </span>
                        <span className="shrink-0 text-sm text-muted group-open:hidden">Open</span>
                        <span className="hidden shrink-0 text-sm text-muted group-open:inline">Close</span>
                      </summary>
                      <div className="mb-3 mt-1 border-t border-border pt-3">
                        <Markdown content={x.content} />
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </section>
          ))}
        </ResourceSearch>
      </div>
    </div>
  );
}
