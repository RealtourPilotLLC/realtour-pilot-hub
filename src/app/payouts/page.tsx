import Link from "next/link";
import { Banknote, Clock, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { ROLE_META } from "@/lib/pipeline";
import { photographerPayout, editorPayout, PAYOUT_RULES } from "@/lib/finance";
import { formatMoney } from "@/lib/utils";
import { format } from "date-fns";

export const dynamic = "force-dynamic";

type Line = {
  projectId: string;
  title: string;
  amount: number;
  role: "Photographer" | "Editor";
  delivered: boolean;
  date: Date | null;
};

export default async function PayoutsPage() {
  const projects = await prisma.project.findMany({
    where: { status: { not: "CANCELLED" } },
    include: { photographer: true, editor: true },
  });

  // Build per-contractor ledgers.
  const ledgers = new Map<
    string,
    { member: { id: string; name: string; avatarColor: string; role: keyof typeof ROLE_META }; lines: Line[] }
  >();

  const add = (
    member: { id: string; name: string; avatarColor: string; role: keyof typeof ROLE_META } | null,
    line: Line,
  ) => {
    if (!member || line.amount <= 0) return;
    if (!ledgers.has(member.id)) ledgers.set(member.id, { member, lines: [] });
    ledgers.get(member.id)!.lines.push(line);
  };

  for (const p of projects) {
    const delivered = p.status === "DELIVERED";
    if (p.photographer && (delivered || p.status === "SCHEDULED" || p.status === "SHOT" || p.status === "EDITING" || p.status === "REVIEW")) {
      add(p.photographer, {
        projectId: p.id,
        title: p.title,
        amount: photographerPayout(p.price),
        role: "Photographer",
        delivered,
        date: p.deliveredAt ?? p.shootDate ?? null,
      });
    }
    if (p.editor && (delivered || p.status === "EDITING" || p.status === "REVIEW")) {
      add(p.editor, {
        projectId: p.id,
        title: p.title,
        amount: editorPayout(p.price),
        role: "Editor",
        delivered,
        date: p.deliveredAt ?? null,
      });
    }
  }

  const contractors = [...ledgers.values()].map((l) => {
    const owed = l.lines.filter((x) => x.delivered).reduce((s, x) => s + x.amount, 0);
    const upcoming = l.lines.filter((x) => !x.delivered).reduce((s, x) => s + x.amount, 0);
    return { ...l, owed, upcoming };
  });

  const totalOwed = contractors.reduce((s, c) => s + c.owed, 0);
  const totalUpcoming = contractors.reduce((s, c) => s + c.upcoming, 0);

  return (
    <div>
      <PageHeader
        title="Contractor Payouts"
        subtitle={`Photographers ${Math.round(PAYOUT_RULES.photographerPct * 100)}% · editors ${Math.round(
          PAYOUT_RULES.editorPct * 100,
        )}% of order`}
        actions={<Badge soft="var(--surface-2)">Stripe transfers — coming with integrations</Badge>}
      />
      <div className="space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border bg-surface p-4">
            <div className="flex items-center gap-2 text-sm text-muted">
              <Banknote className="size-4 text-success" /> Owed now (delivered)
            </div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(totalOwed)}</div>
          </div>
          <div className="rounded-2xl border bg-surface p-4">
            <div className="flex items-center gap-2 text-sm text-muted">
              <Clock className="size-4 text-accent" /> Upcoming (in production)
            </div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(totalUpcoming)}</div>
          </div>
          <div className="rounded-2xl border bg-surface p-4">
            <div className="flex items-center gap-2 text-sm text-muted">
              <CheckCircle2 className="size-4 text-brand" /> Contractors
            </div>
            <div className="mt-2 text-2xl font-semibold">{contractors.length}</div>
          </div>
        </div>

        <div className="space-y-4">
          {contractors.map((c) => (
            <div key={c.member.id} className="rounded-2xl border bg-surface">
              <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <Avatar name={c.member.name} color={c.member.avatarColor} size={32} />
                  <div>
                    <div className="text-sm font-semibold">{c.member.name}</div>
                    <span className="text-xs" style={{ color: ROLE_META[c.member.role].color }}>
                      {ROLE_META[c.member.role].label}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-right">
                  {c.upcoming > 0 && (
                    <div>
                      <div className="text-xs text-muted">Upcoming</div>
                      <div className="text-sm font-medium text-accent">{formatMoney(c.upcoming)}</div>
                    </div>
                  )}
                  <div>
                    <div className="text-xs text-muted">Owed now</div>
                    <div className="text-base font-semibold text-success">{formatMoney(c.owed)}</div>
                  </div>
                  <button
                    disabled
                    title="Available once Stripe is connected"
                    className="cursor-not-allowed rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg opacity-50"
                  >
                    Pay out
                  </button>
                </div>
              </div>
              <div className="divide-y">
                {c.lines
                  .sort((a, b) => Number(b.delivered) - Number(a.delivered))
                  .map((line, i) => (
                    <div key={i} className="flex items-center justify-between px-5 py-2.5 text-sm">
                      <div className="flex items-center gap-2">
                        <Link href={`/projects/${line.projectId}`} className="font-medium hover:underline">
                          {line.title}
                        </Link>
                        <Badge soft="var(--surface-2)">{line.role}</Badge>
                        {line.delivered ? (
                          <Badge color="#16a34a" soft="#dcfce7">
                            Delivered
                          </Badge>
                        ) : (
                          <Badge color="#0ea5e9" soft="#e0f2fe">
                            In production
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        {line.date && (
                          <span className="text-xs text-muted">{format(line.date, "MMM d")}</span>
                        )}
                        <span className="font-semibold">{formatMoney(line.amount)}</span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
