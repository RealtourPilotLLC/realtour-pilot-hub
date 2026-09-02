import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowRight, BookOpen, ExternalLink, ListChecks } from "lucide-react";
import { requirePageAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { Section } from "@/components/ui/Section";
import { Markdown } from "@/components/ui/Markdown";
import {
  GUIDES, GUIDE_BLURB, GUIDE_ORDER, canOpenGuide, guideForRole,
  type GuideKey, type GuideLink,
} from "../content";

export const dynamic = "force-dynamic";

// One role's walkthrough guide. The content lives in ../content.ts and renders
// through the same <Markdown> primitive the SOP Center uses, so a guide reads
// like every other document in the hub.
//
// SCOPING: middleware only proves this path belongs to the `resources` key
// (every role has it), so the audience gate is here. A creative who types
// another role's URL is sent to their own guide rather than shown a 404 —
// they asked for help, they should land on help.

function isGuideKey(s: string): s is GuideKey {
  return (GUIDE_ORDER as string[]).includes(s);
}

function LinkChip({ l }: { l: GuideLink }) {
  const cls =
    "inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand hover:text-brand";
  return l.external ? (
    <a href={l.href} target="_blank" rel="noopener noreferrer" className={cls}>
      {l.label} <ExternalLink className="size-3" />
    </a>
  ) : (
    <Link href={l.href} className={cls}>
      {l.label} <ArrowRight className="size-3" />
    </Link>
  );
}

export default async function RoleGuidePage({ params }: { params: Promise<{ role: string }> }) {
  await requirePageAccess("resources");
  const { role: raw } = await params;
  if (!isGuideKey(raw)) notFound();

  const me = await getCurrentUser().catch(() => null);
  if (me && !canOpenGuide(me.role, raw)) redirect(`/resources/guide/${guideForRole(me.role)}`);

  const g = GUIDES[raw];
  // Creatives see the Resources page as the "SOP Center" (Sidebar renames it),
  // so the back link has to say what they'll actually land on.
  const creative = me?.role === "EDITOR" || me?.role === "PHOTOGRAPHER";
  const others = GUIDE_ORDER.filter((k) => k !== raw && (!me || canOpenGuide(me.role, k)));

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/resources" label={creative ? "SOP Center" : "Resources & SOPs"} />
      </div>
      <PageHeader eyebrow={g.eyebrow} title={g.title} subtitle={g.subtitle} />

      <div className="mx-auto max-w-3xl space-y-4 p-4 pb-16 sm:p-6">
        {/* The one-page runbook: the whole day in order, before any detail. */}
        <section className="panel-shadow rounded-2xl border border-brand/30 bg-brand/[0.04] p-5">
          <div className="flex items-center gap-2">
            <ListChecks className="size-4 text-brand" />
            <h2 className="text-sm font-semibold">The runbook — your day in order</h2>
          </div>
          <p className="mt-1 text-xs text-muted">Written for {g.who}. Everything below this card is the detail behind one of these lines.</p>
          <ol className="mt-3 space-y-2.5">
            {g.runbook.map((r, i) => (
              <li key={i} className="flex gap-3">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[11px] font-bold text-brand">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 text-sm leading-relaxed">
                  <span className="font-semibold">{r.when}</span>
                  <span className="text-muted-2"> — </span>
                  <span className="text-foreground/85">{r.what}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        {/* Jump bar — a guide this long is unusable without one. */}
        <nav aria-label="Sections" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 py-1 sm:-mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden">
          {g.sections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="inline-flex shrink-0 items-center rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              {s.title}
            </a>
          ))}
        </nav>

        {g.sections.map((s) => (
          // scroll-mt clears the sticky PageHeader on a jump (same value the
          // Ops Day blocks use).
          <div key={s.id} id={s.id} className="scroll-mt-32 md:scroll-mt-28">
            <Section icon={s.icon} title={s.title}>
              <Markdown content={s.body} />
              {s.links && s.links.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                  {s.links.map((l) => <LinkChip key={l.href} l={l} />)}
                </div>
              )}
            </Section>
          </div>
        ))}

        <p className="rounded-2xl border border-dashed border-border bg-surface px-4 py-3 text-sm text-muted">
          {g.askLine}
        </p>

        {others.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2 px-1">
              <BookOpen className="size-3.5 text-muted-2" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">The other guides</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {others.map((k) => (
                <Link
                  key={k}
                  href={`/resources/guide/${k}`}
                  className="rounded-2xl border border-border bg-surface p-3.5 transition-colors hover:border-brand/40"
                >
                  <div className="text-sm font-semibold">{GUIDES[k].title}</div>
                  <div className="mt-0.5 text-xs text-muted">{GUIDE_BLURB[k]}</div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
