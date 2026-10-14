import Link from "next/link";
import { AlertTriangle, Camera, FlaskConical, Images, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { etMonthDay, etMonthDayTime } from "@/lib/datetime";
import { PhotoImg } from "./PhotoImg";
import { SlaChip } from "./SlaChip";
import { HOLD_REASON_LABEL, SEVERITY_CLASS, SEVERITY_LABEL, plural } from "./format";
import type { QueueCard, QueueColumn, QueueData, Severity } from "./types";

// ---------------------------------------------------------------------------
// THE QUEUE (plan 9.3): a board by default, a table on request, both sorted by
// SLA due. On a desktop the board is columns side by side; on a phone the
// same columns stack, so an approval or an alert is one scroll away and never
// a sideways hunt.
// ---------------------------------------------------------------------------

const FIX_TONE = { ok: "text-success", warn: "text-warning", danger: "text-danger", muted: "text-muted" } as const;
const ODD_STAGES = new Set(["EDIT_FAILED", "EDITED", "DELIVERY_MISMATCH", "REVISION_REQUESTED"]);

function IssueCounts({ issues }: { issues: Record<Severity, number> }) {
  const sev: Severity[] = ["CRITICAL", "MAJOR", "MINOR"];
  const any = sev.some((s) => issues[s] > 0);
  if (!any) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {sev.map((s) =>
        issues[s] > 0 ? (
          <span key={s} className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[12px] font-semibold ring-1 ring-inset", SEVERITY_CLASS[s])} title={`${issues[s]} open ${SEVERITY_LABEL[s].toLowerCase()} issue${issues[s] === 1 ? "" : "s"}`}>
            {issues[s]} {SEVERITY_LABEL[s].toLowerCase()}
          </span>
        ) : null,
      )}
    </span>
  );
}

function Card({ card, nowIso }: { card: QueueCard; nowIso: string }) {
  const delivered = card.stage === "DELIVERED";
  const unpaid = card.paymentStatus && /UNPAID|PARTIAL/i.test(card.paymentStatus);
  return (
    <Link
      href={`/ops/photo-delivery/${card.id}`}
      className={cn(
        "group block rounded-xl border bg-surface p-3 transition-colors hover:border-border-strong hover:bg-surface-2/40 focus-visible:outline-2 focus-visible:outline-brand",
        card.atRisk ? "border-warning/40" : "border-border",
      )}
    >
      <div className="flex gap-3">
        <div className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-surface-2 sm:size-[4.5rem]">
          {card.hero ? (
            <PhotoImg photoId={card.hero.photoId} hash={card.hero.hash} fallbackUrl={card.hero.fallbackUrl} size="thumb256" alt={card.hero.alt} className="size-full object-cover" />
          ) : (
            <span className="flex size-full items-center justify-center text-muted" aria-hidden><Images className="size-5" /></span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="break-words font-semibold leading-snug group-hover:text-brand">{card.street}</p>
          <p className="break-words text-[13px] text-muted">
            {card.clientName ?? "No client"}
            {card.photographerName && (
              <>
                {" · "}
                <Camera aria-hidden className="inline size-3 align-[-1px]" /> {card.photographerName}
              </>
            )}
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
        {delivered ? (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 font-medium text-muted ring-1 ring-inset ring-border">Delivered {card.deliveredAt ? etMonthDayTime(card.deliveredAt) : ""}</span>
        ) : (
          <SlaChip dueAt={card.slaDueAt} serverNow={nowIso} />
        )}
        {ODD_STAGES.has(card.stage) && (
          <span className={cn("rounded-full px-2 py-0.5 font-medium ring-1 ring-inset", card.stage === "EDIT_FAILED" || card.stage === "DELIVERY_MISMATCH" ? SEVERITY_CLASS.CRITICAL : "bg-surface-2 text-muted ring-border")}>
            {card.stageLabel}
          </span>
        )}
        {card.holdReason && card.stage === "ON_HOLD" && <span className={cn("rounded-full px-2 py-0.5 font-medium ring-1 ring-inset", SEVERITY_CLASS.MAJOR)}>{HOLD_REASON_LABEL[card.holdReason] ?? card.holdReason}</span>}
        <span className="text-muted">{plural(card.photoCount, "photo")}</span>
        <IssueCounts issues={card.issues} />
        {card.shadow && (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 font-medium text-muted ring-1 ring-inset ring-border" title="QC is advisory on this job (shadow mode)">
            <FlaskConical aria-hidden className="size-3" /> Shadow
          </span>
        )}
        {card.fix && (
          <span className={cn("inline-flex items-center gap-1 font-medium", FIX_TONE[card.fix.tone])}>
            <Wrench aria-hidden className="size-3" /> {card.fix.label}
          </span>
        )}
        {unpaid && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted ring-1 ring-inset ring-border">Unpaid</span>}
      </div>
      {card.lastError && (
        <p className="mt-1.5 flex items-start gap-1 text-[12px] text-warning">
          <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">{card.lastError}</span>
        </p>
      )}
    </Link>
  );
}

function Column({ col, nowIso }: { col: QueueColumn; nowIso: string }) {
  const headingId = `pd-col-${col.key}`;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col rounded-2xl border border-border bg-surface-2/30 lg:w-[19rem] lg:shrink-0">
      <header className="flex items-baseline gap-2 border-b border-border px-3 py-2.5">
        <h2 id={headingId} className="text-sm font-semibold">{col.label}</h2>
        <span className="rounded-full bg-surface-2 px-2 text-ui-status font-medium text-muted">{col.cards.length}</span>
      </header>
      <p className="px-3 pt-2 text-[12px] leading-snug text-muted">{col.hint}</p>
      <div className="flex flex-col gap-2 p-2 lg:max-h-[calc(100dvh-20rem)] lg:overflow-y-auto">
        {col.cards.length === 0 ? <p className="px-1 py-2 text-[13px] text-muted-2">Nothing here.</p> : col.cards.map((card) => <Card key={card.id} card={card} nowIso={nowIso} />)}
      </div>
    </section>
  );
}

export function QueueBoard({ data }: { data: QueueData }) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:overflow-x-auto lg:pb-2">
      {data.columns.map((col) => (
        <Column key={col.key} col={col} nowIso={data.nowIso} />
      ))}
    </div>
  );
}

export function QueueTable({ data }: { data: QueueData }) {
  const rows = data.columns.flatMap((c) => c.cards.map((card) => ({ card, column: c.label })));
  if (!rows.length) return null;
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface">
      <table className="w-full min-w-[56rem] text-sm">
        <caption className="sr-only">Photo jobs, sorted by when they are due</caption>
        <thead className="border-b border-border text-left text-[12px] uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Job</th>
            <th scope="col" className="px-3 py-2 font-medium">Stage</th>
            <th scope="col" className="px-3 py-2 font-medium">Due</th>
            <th scope="col" className="px-3 py-2 font-medium">Photos</th>
            <th scope="col" className="px-3 py-2 font-medium">Open issues</th>
            <th scope="col" className="px-3 py-2 font-medium">Photographer</th>
            <th scope="col" className="px-3 py-2 font-medium">Fixes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(({ card, column }) => (
            <tr key={card.id} className={cn("align-top hover:bg-surface-2/40", card.atRisk && "bg-warning-soft/20")}>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="relative size-10 shrink-0 overflow-hidden rounded-md bg-surface-2">
                    {card.hero && <PhotoImg photoId={card.hero.photoId} hash={card.hero.hash} fallbackUrl={card.hero.fallbackUrl} size="thumb256" alt="" className="size-full object-cover" />}
                  </span>
                  <span className="min-w-0">
                    <Link href={`/ops/photo-delivery/${card.id}`} className="font-semibold hover:text-brand hover:underline">{card.street}</Link>
                    <span className="block text-[13px] text-muted">{card.clientName ?? "No client"}</span>
                  </span>
                </div>
              </td>
              <td className="px-3 py-2.5">
                <span className="block">{column}</span>
                {card.stageLabel !== column && <span className="block text-[12px] text-muted">{card.stageLabel}</span>}
                {card.shadow && <span className="block text-[12px] text-muted">Shadow QC</span>}
              </td>
              <td className="px-3 py-2.5">
                {card.stage === "DELIVERED" ? <span className="text-muted">{card.deliveredAt ? `Delivered ${etMonthDay(card.deliveredAt)}` : "Delivered"}</span> : <SlaChip dueAt={card.slaDueAt} serverNow={data.nowIso} />}
              </td>
              <td className="px-3 py-2.5 tabular-nums">{card.photoCount}</td>
              <td className="px-3 py-2.5">
                <IssueCounts issues={card.issues} />
                {!card.issues.CRITICAL && !card.issues.MAJOR && !card.issues.MINOR && <span className="text-muted">None</span>}
              </td>
              <td className="px-3 py-2.5 text-muted">{card.photographerName ?? "Not set"}</td>
              <td className={cn("px-3 py-2.5", card.fix ? FIX_TONE[card.fix.tone] : "text-muted")}>{card.fix?.label ?? "None"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
