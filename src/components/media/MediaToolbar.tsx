"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

// Search by address or client, a date range, newest or oldest first. A plain
// GET form (it works before the page's script loads); with script, the
// choices apply as they are made and the page keeps its scroll.

const field = "h-11 rounded-xl border border-border-strong bg-surface px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export function MediaToolbar({ basePath, tab, q, range, sort, years, placeholder = "Search by address or client" }: {
  basePath: string;
  tab?: string | null;
  q: string;
  range: string;
  sort: string;
  years: number[];
  placeholder?: string;
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const go = () => {
    if (!form.current) return;
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(form.current)) {
      if (typeof v !== "string") continue;
      const value = v.trim();
      if (!value || (k === "range" && value === "all") || (k === "sort" && value === "new")) continue;
      params.set(k, value);
    }
    const qs = params.toString();
    router.push(`${basePath}${qs ? `?${qs}` : ""}`, { scroll: false });
  };
  return (
    <form
      ref={form}
      method="get"
      action={basePath}
      role="search"
      onSubmit={(e) => { e.preventDefault(); go(); }}
      className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
    >
      {tab && <input type="hidden" name="tab" value={tab} />}
      <label className="relative col-span-2 min-w-0 sm:flex-1 sm:basis-64">
        <span className="sr-only">Search</span>
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-2" />
        <input name="q" type="search" defaultValue={q} placeholder={placeholder} enterKeyHint="search" autoComplete="off" className={`${field} w-full pl-9`} />
      </label>
      <label className="min-w-0">
        <span className="sr-only">Dates</span>
        <select name="range" defaultValue={range} onChange={go} className={`${field} w-full sm:w-auto`}>
          <option value="all">All dates</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="365d">Last 12 months</option>
          {years.map((y) => <option key={y} value={`y${y}`}>{y}</option>)}
        </select>
      </label>
      <label className="min-w-0">
        <span className="sr-only">Order</span>
        <select name="sort" defaultValue={sort} onChange={go} className={`${field} w-full sm:w-auto`}>
          <option value="new">Newest first</option>
          <option value="old">Oldest first</option>
        </select>
      </label>
      <button type="submit" className="col-span-2 inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-brand-action px-4 text-sm font-semibold text-brand-fg hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:col-span-1">
        <Search aria-hidden className="size-4" />Search
      </button>
    </form>
  );
}
