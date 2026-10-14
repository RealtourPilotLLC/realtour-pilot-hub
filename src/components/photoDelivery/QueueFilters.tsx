"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LayoutGrid, Loader2, Rows3 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QueueData } from "./types";
import { queueHref, type QueueParams } from "./format";

// ---------------------------------------------------------------------------
// Queue filters (plan 9.3: client, photographer, at-risk only) and the board /
// table switch. A plain GET form underneath, so it works before the script
// loads; with the script, each change applies at once.
// ---------------------------------------------------------------------------

type Params = QueueParams;
const hrefFor = queueHref;

const select = "min-h-11 max-w-full rounded-lg border border-border-strong bg-surface-2 px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-brand";

export function QueueFilters({ data, view }: { data: QueueData; view: "board" | "table" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const cur: Params = { client: data.filters.client, photographer: data.filters.photographer, risk: data.filters.atRisk, view };
  const go = (next: Partial<Params>) => start(() => router.replace(hrefFor({ ...cur, ...next }), { scroll: false }));
  const filtered = !!(cur.client || cur.photographer || cur.risk);
  return (
    <form
      key={`${cur.client}|${cur.photographer}|${cur.risk}`}
      method="get"
      action="/ops/photo-delivery"
      className="flex flex-wrap items-end gap-x-3 gap-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        go({ client: (f.get("client") as string) || null, photographer: (f.get("photographer") as string) || null, risk: f.get("risk") === "1" });
      }}
    >
      <label className="flex min-w-0 flex-col gap-1 text-[13px] font-medium text-muted">
        Client
        <select name="client" className={select} defaultValue={cur.client ?? ""} onChange={(e) => go({ client: e.target.value || null })}>
          <option value="">All clients</option>
          {data.clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-[13px] font-medium text-muted">
        Photographer
        <select name="photographer" className={select} defaultValue={cur.photographer ?? ""} onChange={(e) => go({ photographer: e.target.value || null })}>
          <option value="">All photographers</option>
          {data.photographers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border-strong px-3 text-sm">
        <input type="checkbox" name="risk" value="1" defaultChecked={cur.risk} onChange={(e) => go({ risk: e.target.checked })} className="size-4 accent-[var(--brand)]" />
        At risk only
      </label>
      {view === "table" && <input type="hidden" name="view" value="table" />}
      <noscript>
        <button type="submit" className="min-h-11 rounded-lg border border-border-strong px-3 text-sm font-medium">Apply</button>
      </noscript>
      {filtered && (
        <Link href={hrefFor({ client: null, photographer: null, risk: false, view })} className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-muted hover:text-foreground">
          Clear filters
        </Link>
      )}
      {pending && <Loader2 aria-label="Updating" className="mb-3 size-4 animate-spin text-muted motion-reduce:animate-none" />}
      <div role="group" aria-label="View" className="ml-auto inline-flex rounded-lg border border-border-strong p-0.5">
        {(["board", "table"] as const).map((v) => (
          <Link
            key={v}
            href={hrefFor({ ...cur, view: v })}
            aria-current={view === v ? "page" : undefined}
            className={cn("inline-flex min-h-10 items-center gap-1.5 rounded-md px-3 text-sm font-medium", view === v ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground")}
          >
            {v === "board" ? <LayoutGrid aria-hidden className="size-4" /> : <Rows3 aria-hidden className="size-4" />}
            {v === "board" ? "Board" : "Table"}
          </Link>
        ))}
      </div>
    </form>
  );
}
