import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, BookOpen } from "lucide-react";
import { requirePageAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { GUIDES, GUIDE_BLURB, GUIDE_ORDER, canOpenGuide, guideForRole } from "./content";

export const dynamic = "force-dynamic";

// The guide door. A photographer or an editor has exactly one guide, so they
// are taken straight to it — a chooser with one option is a wasted tap. Owner
// and admin get the list, with their own guide pinned first.
export default async function GuideIndexPage() {
  await requirePageAccess("resources");
  const me = await getCurrentUser().catch(() => null);
  const mine = guideForRole(me?.role);
  if (me && (me.role === "EDITOR" || me.role === "PHOTOGRAPHER")) {
    redirect(`/resources/guide/${mine}`);
  }

  const visible = GUIDE_ORDER.filter((k) => !me || canOpenGuide(me.role, k));
  const ordered = [mine, ...visible.filter((k) => k !== mine)].filter((k) => visible.includes(k));

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/resources" label="Resources & SOPs" />
      </div>
      <PageHeader
        eyebrow="Walkthrough"
        title="How the hub works"
        subtitle="One guide per role — the runbook for the day, then the screens behind it"
      />
      <div className="mx-auto max-w-3xl space-y-3 p-4 pb-16 sm:p-6">
        {ordered.map((k) => {
          const g = GUIDES[k];
          const isMine = k === mine;
          return (
            <Link
              key={k}
              href={`/resources/guide/${k}`}
              className={`flex items-center gap-3 rounded-2xl border bg-surface p-4 transition-colors hover:border-brand ${
                isMine ? "border-brand/40 bg-brand/[0.04]" : "border-border"
              }`}
            >
              <span
                className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
                  isMine ? "bg-brand/15 text-brand" : "bg-surface-2 text-muted"
                }`}
              >
                <BookOpen className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{g.title}</span>
                  {isMine && (
                    <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand">
                      Yours
                    </span>
                  )}
                  <span className="text-xs text-muted-2">{g.who}</span>
                </span>
                <span className="mt-0.5 block text-xs text-muted">{GUIDE_BLURB[k]}</span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-2" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
