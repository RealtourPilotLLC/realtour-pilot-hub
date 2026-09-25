import Link from "next/link";
import { BookOpen, ChevronRight, KeyRound, LogOut, MessageSquare, Palette, ScrollText, Settings, type LucideIcon } from "lucide-react";
import { signOutPortal } from "@/app/portal/login/actions";
import type { NavItem, PortalDest } from "@/lib/portalNav";
import { Card, CountBadge } from "@/components/portal/ui";

// ---------------------------------------------------------------------------
// MORE — the v2 layout's fifth destination (UI-01, Sep 24 2026). It used to
// be a <details> popover on the phone bar and an account menu in the corner,
// which is how Brand Profile ended up somewhere a client never looked. Now it
// is a real page: Brand Profile, Messages, Resources (only when a guide is
// published), Settings & Team, Terms, then who you are and signing out. No
// script, no stale open state. Anything here that needs doing (setup steps,
// an unread reply) is ALSO on Home — More is never the only way to it.
//
// Also the Terms page body, which v2 renders from the same text v1 does
// (AppSetting `portal-terms`, else PortalPage's DEFAULT_TERMS).
// ---------------------------------------------------------------------------

const ICON: Partial<Record<PortalDest, LucideIcon>> = { brand: Palette, messages: MessageSquare, resources: BookOpen, team: Settings, terms: ScrollText };
const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export type MoreTabData = {
  items: (NavItem & { href: string })[];
  /** Brand Profile's line when account setup is not complete. */
  setupLeft: number | null;
  who: string | null;
  staff: boolean;
  clientFirst: string;
  canSignOut: boolean;
  offerSignIn: boolean;
};

export function MoreTab({ d }: { d: MoreTabData }) {
  return (
    <div className="mt-6 space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">More</h1>
      <Card className="p-1.5">
        <ul className="divide-y divide-border">
          {d.items.map((i) => {
            const Icon = ICON[i.dest] ?? ChevronRight;
            const hint = i.dest === "brand" && d.setupLeft ? `${d.setupLeft} setup step${d.setupLeft === 1 ? "" : "s"} left` : i.hint;
            return (
              <li key={i.dest}>
                <Link href={i.href} className={`flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 hover:bg-surface-2/60 ${focus}`}>
                  <Icon className="size-5 shrink-0 text-brand" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{i.label}</span>
                    {hint && <span className={`block text-xs ${i.dest === "brand" && d.setupLeft ? "font-medium text-brand" : "text-muted"}`}>{hint}</span>}
                  </span>
                  <CountBadge n={i.badge} label={i.dest === "messages" ? "unread" : "waiting"} />
                  <ChevronRight className="size-4 shrink-0 text-muted-2" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card>
        <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Account</div>
        <p className="mt-1.5 text-sm">
          {d.who
            ? d.staff ? <>Viewing as <span className="font-semibold">{d.who}</span> on {d.clientFirst}&rsquo;s behalf</> : <>Signed in as <span className="font-semibold">{d.who}</span></>
            : <span className="text-muted">You&rsquo;re using your program link. It works on any device you open it on.</span>}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {d.canSignOut && (
            <form action={signOutPortal}>
              <button type="submit" className={`inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm font-semibold text-muted hover:text-foreground ${focus}`}><LogOut className="size-4" aria-hidden /> Sign out</button>
            </form>
          )}
          {d.offerSignIn && <Link href="/portal/login" className={`inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand px-3 text-sm font-semibold text-white ${focus}`}><KeyRound className="size-4" aria-hidden /> Sign in with email</Link>}
        </div>
      </Card>
    </div>
  );
}

/** The terms, split the way v1 splits them: blank lines separate blocks, "## " starts a heading, "- " lines are a list. */
export function TermsCard({ blocks }: { blocks: string[] }) {
  const list = (lines: string[]) => (
    <ul className="space-y-1 pl-1">{lines.filter((l) => l.trim().startsWith("- ")).map((l, j) => <li key={j} className="flex gap-2 text-sm leading-relaxed text-foreground/85"><span className="text-brand" aria-hidden>·</span><span>{l.trim().replace(/^- /, "")}</span></li>)}</ul>
  );
  return (
    <div className="mt-6 space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Terms</h1>
      <Card>
        <div className="space-y-3">
          {blocks.map((block, i) => {
            if (block.startsWith("## ")) {
              const [head, ...rest] = block.split("\n");
              const body = rest.join("\n").trim();
              return (
                <div key={i}>
                  <h2 className="pt-2 text-sm font-bold text-foreground">{head.replace(/^## /, "")}</h2>
                  {body && (rest.every((l) => !l.trim() || l.trim().startsWith("- ")) ? <div className="mt-2">{list(rest)}</div> : <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/85">{body}</p>)}
                </div>
              );
            }
            const lines = block.split("\n");
            if (lines.every((l) => l.trim().startsWith("- "))) return <div key={i}>{list(lines)}</div>;
            return <p key={i} className="whitespace-pre-line text-sm leading-relaxed text-foreground/85">{block}</p>;
          })}
        </div>
      </Card>
    </div>
  );
}
