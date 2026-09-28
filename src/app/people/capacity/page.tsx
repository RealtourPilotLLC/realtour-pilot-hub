import { redirect } from "next/navigation";
import { CalendarOff, History } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { BackLink } from "@/components/ui/BackLink";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { SELF_SERVICE_KINDS, capacityRegister, type CapacityKind, type CapacityRegisterRow } from "@/lib/capacity";
import { CancelCapacityButton, CapacityForm } from "./CapacityForm";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// TIME OFF, TRAINING AND BLOCKED TIME (§10 capacity and training, Sep 26 2026).
//
// The register behind the chips on the Editing Room's workload panel. The
// office records anything for anyone — a day off, protected training time, a
// backup editor for a week (as Other, with a note: the software records the
// decision, it does not make it). An editor sees only their own entries and
// can record being offline or blocked.
//
// Not a nav page (People is /users); reached from the workload panel's link.
// Everyone else is sent home. Nothing on this page reassigns work, moves a due
// date or touches pay.
// ---------------------------------------------------------------------------

const ET = "America/New_York";
const stamp = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const STATE_WORD: Record<CapacityRegisterRow["state"], string> = {
  now: "In force",
  upcoming: "Coming up",
  ended: "Ended",
  cancelled: "Cancelled",
};

export default async function CapacityPage() {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/people/capacity");
  const office = !me || me.realRole === "OWNER" || me.realRole === "ADMIN";
  const editor = !!me && me.realRole === "EDITOR";
  if (!office && !editor) redirect(homeFor(me?.role ?? "PHOTOGRAPHER"));
  // An editor with no roster link cannot be scoped — fail closed with a nudge.
  const selfId = editor ? me?.teamMemberId ?? null : null;

  const [rows, roster] = await Promise.all([
    editor ? (selfId ? capacityRegister({ onlyTeamMemberId: selfId }) : Promise.resolve([] as CapacityRegisterRow[])) : capacityRegister(),
    office
      ? prisma.teamMember.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } })
      : selfId
        ? prisma.teamMember.findMany({ where: { id: selfId, active: true }, select: { id: true, name: true } })
        : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  const live = rows.filter((r) => r.state === "now" || r.state === "upcoming").sort((a, b) => a.startsAtISO.localeCompare(b.startsAtISO));
  const past = rows.filter((r) => r.state === "ended" || r.state === "cancelled");
  const mayCancel = (r: CapacityRegisterRow) =>
    office || (editor && r.teamMemberId === selfId && SELF_SERVICE_KINDS.has(r.kind as CapacityKind));

  return (
    <div>
      <PageHeader
        eyebrow="People"
        title="Time off, training & blocked time"
        subtitle={
          editor
            ? "Tell the office when you're offline or stuck — it shows beside your name in the Editing Room."
            : "Who is out, now and this week. Shown on the Editing Room's workload panel; nothing is reassigned automatically."
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">
        <BackLink href="/editing" label="Editing Room" />
        {editor && !selfId ? (
          <p className="rounded-xl border border-warning/30 bg-warning-soft/40 px-4 py-3 text-sm text-foreground">
            Your login isn&rsquo;t linked to a roster profile yet — ask Jordan or Kyle to finish it.
          </p>
        ) : (
          <Section icon={CalendarOff} title={editor ? "Record that you're offline or blocked" : "Record time off, training or blocked time"} flush>
            <CapacityForm people={roster} selfOnly={editor} />
          </Section>
        )}
        <Section icon={CalendarOff} title="Now and coming up" count={live.length} flush>
          {live.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted">Nobody is marked out.</p>
          ) : (
            <ul className="divide-y divide-border">
              {live.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 px-5 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      {r.person} <span className="font-normal text-muted">· {r.label} · {r.when}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-2">
                      {STATE_WORD[r.state]} · recorded by {r.recordedBy} {stamp(r.createdAtISO)} ET
                      {r.note && <span className="text-muted"> · “{r.note}”</span>}
                    </div>
                  </div>
                  {mayCancel(r) && <CancelCapacityButton id={r.id} />}
                </li>
              ))}
            </ul>
          )}
        </Section>
        {past.length > 0 && (
          <Section icon={History} title="The last 30 days" count={past.length} flush>
            <ul className="divide-y divide-border">
              {past.map((r) => (
                <li key={r.id} className="px-5 py-2.5 text-[12px] text-muted">
                  <span className="font-medium text-foreground/80">{r.person}</span> · {r.label} · {r.when} ·{" "}
                  {r.state === "cancelled" ? `cancelled${r.cancelledBy ? ` by ${r.cancelledBy}` : ""}` : "ended"}
                  {r.note && <span className="text-muted-2"> · “{r.note}”</span>}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}
