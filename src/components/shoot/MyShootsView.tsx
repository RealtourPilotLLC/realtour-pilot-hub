"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, MapPin, CheckCircle2, Upload as UploadIcon, Camera, X, Eye } from "lucide-react";
import { etDayKey, etTime, etFullDate } from "@/lib/datetime";
import { DELIVERABLE_META } from "@/lib/pipeline";
import { Badge } from "@/components/ui/Badge";
import { PALETTE } from "@/lib/palette";
import { cn } from "@/lib/utils";
import type { MyShootRow } from "@/lib/shoot";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const cellKey = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export function MyShootsView({
  rows,
  showWho,
  meId,
  viewAs,
}: {
  rows: MyShootRow[];
  showWho: boolean;
  meId: string | null;
  viewAs: { id: string; name: string } | null;
}) {
  const router = useRouter();
  // Owner/admin photographer filter — toggle each photographer's shoots on/off
  // (persisted across visits). Photographers themselves are scoped server-side.
  const photographers = useMemo(() => {
    if (!showWho) return [];
    const m = new Map<string, { key: string; name: string; color: string; count: number }>();
    for (const r of rows) {
      const key = r.photographerId ?? "unassigned";
      if (!m.has(key)) m.set(key, { key, name: r.photographerName ?? "Unassigned", color: r.photographerColor ?? "#9aa4b2", count: 0 });
      m.get(key)!.count++;
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [rows, showWho]);

  const [off, setOff] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem("rtp_shootFilterOff");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setOff(new Set(JSON.parse(raw) as string[]));
    } catch { /* ignore */ }
  }, []);
  const persist = (s: Set<string>) => { try { localStorage.setItem("rtp_shootFilterOff", JSON.stringify([...s])); } catch { /* ignore */ } };
  const togglePhotog = (key: string) =>
    setOff((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); persist(n); return n; });
  const showAll = () => { const n = new Set<string>(); setOff(n); persist(n); };
  const onlyMine = () => { if (!meId) return; const n = new Set(photographers.map((p) => p.key).filter((k) => k !== meId)); setOff(n); persist(n); };

  const visible = useMemo(
    () => (showWho ? rows.filter((r) => !off.has(r.photographerId ?? "unassigned")) : rows),
    [rows, off, showWho],
  );

  // Bucket shoots by their ET calendar day.
  const byDay = useMemo(() => {
    const m = new Map<string, MyShootRow[]>();
    for (const r of visible) {
      if (!r.whenISO) continue;
      const k = etDayKey(new Date(r.whenISO));
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    for (const list of m.values()) list.sort((a, b) => (a.whenISO ?? "").localeCompare(b.whenISO ?? ""));
    return m;
  }, [visible]);

  const todayKey = etDayKey(new Date());
  const [cursor, setCursor] = useState(() => {
    const [y, mo] = todayKey.split("-").map(Number);
    return { y, m: mo - 1 };
  });
  const [selected, setSelected] = useState<string | null>(null);

  // Calendar grid for the cursor month.
  const startWd = new Date(cursor.y, cursor.m, 1).getDay();
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startWd; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const shiftMonth = (delta: number) => {
    setCursor((c) => {
      const m = c.m + delta;
      return { y: c.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
    });
  };

  // Which day-groups to list: the selected day, else all (upcoming first, then recent).
  const ordered = useMemo(() => {
    const keys = [...byDay.keys()];
    const future = keys.filter((k) => k >= todayKey).sort();
    const past = keys.filter((k) => k < todayKey).sort().reverse();
    return [...future, ...past];
  }, [byDay, todayKey]);

  const groups = selected ? [selected] : ordered;

  return (
    <div className="space-y-5">
      {/* Owner is stepping into a specific photographer's view */}
      {viewAs && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-brand/30 bg-brand-soft/30 p-3">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <Eye className="size-4 shrink-0 text-brand" />
            <span className="truncate">
              <span className="font-semibold">Viewing as {viewAs.name}</span>
              <span className="text-muted"> · read-only preview</span>
            </span>
          </div>
          <Link
            href="/shoot"
            className="shrink-0 rounded-lg border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
          >
            Exit
          </Link>
        </div>
      )}

      {/* Owner: jump into a single photographer's view */}
      {showWho && photographers.some((p) => p.key !== "unassigned") && (
        <label className="flex items-center gap-2 rounded-2xl border bg-surface px-3 py-2 text-sm">
          <Eye className="size-4 shrink-0 text-muted-2" />
          <span className="shrink-0 text-muted">See a photographer’s view:</span>
          <select
            value=""
            onChange={(e) => { if (e.target.value) router.push(`/shoot?as=${e.target.value}`); }}
            className="min-w-0 flex-1 cursor-pointer bg-transparent font-medium focus:outline-none"
          >
            <option value="">Choose…</option>
            {photographers
              .filter((p) => p.key !== "unassigned")
              .map((p) => (
                <option key={p.key} value={p.key}>{p.name} ({p.count})</option>
              ))}
          </select>
        </label>
      )}

      {/* Photographer filter (owner/admin only) */}
      {showWho && photographers.length > 1 && (
        <div className="rounded-2xl border bg-surface p-3">
          <div className="mb-2 flex items-center justify-between px-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-2">Photographers</span>
            <div className="flex items-center gap-2.5 text-xs">
              {meId && photographers.some((p) => p.key === meId) && (
                <button onClick={onlyMine} className="font-medium text-brand hover:underline">Only mine</button>
              )}
              <button onClick={showAll} className="text-muted hover:text-foreground">All</button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {photographers.map((p) => {
              const on = !off.has(p.key);
              return (
                <button
                  key={p.key}
                  onClick={() => togglePhotog(p.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all",
                    on ? "bg-surface-2 text-foreground" : "border-dashed text-muted-2 opacity-55",
                  )}
                >
                  <span
                    className="size-2 rounded-full"
                    style={on ? { background: p.color } : { boxShadow: `inset 0 0 0 1.5px ${p.color}` }}
                  />
                  {p.name}<span className="ml-0.5 text-muted-2">{p.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Calendar */}
      <div className="rounded-2xl border bg-surface p-3 panel-shadow">
        <div className="mb-2 flex items-center justify-between px-1">
          <div className="text-sm font-semibold">{MONTHS[cursor.m]} {cursor.y}</div>
          <div className="flex items-center gap-1">
            <button onClick={() => shiftMonth(-1)} className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground" aria-label="Previous month"><ChevronLeft className="size-4" /></button>
            <button
              onClick={() => { const [y, mo] = todayKey.split("-").map(Number); setCursor({ y, m: mo - 1 }); }}
              className="rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"
            >
              Today
            </button>
            <button onClick={() => shiftMonth(1)} className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground" aria-label="Next month"><ChevronRight className="size-4" /></button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center">
          {WD.map((d) => <div key={d} className="pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-2">{d}</div>)}
          {cells.map((d, i) => {
            if (d === null) return <div key={`b${i}`} />;
            const key = cellKey(cursor.y, cursor.m, d);
            const count = byDay.get(key)?.length ?? 0;
            const isToday = key === todayKey;
            const isSel = key === selected;
            return (
              <button
                key={key}
                onClick={() => count > 0 && setSelected(isSel ? null : key)}
                disabled={count === 0}
                className={cn(
                  "flex aspect-square flex-col items-center justify-center rounded-lg text-sm transition-colors",
                  isSel ? "bg-brand font-semibold text-brand-fg"
                    : isToday ? "bg-brand-soft text-brand ring-1 ring-inset ring-brand/30"
                    : count > 0 ? "text-foreground hover:bg-surface-2"
                    : "text-muted-2",
                )}
              >
                <span>{d}</span>
                {count > 0 && (
                  <span className="mt-0.5 flex gap-0.5">
                    {Array.from({ length: Math.min(count, 3) }).map((_, j) => (
                      <span key={j} className={cn("size-1 rounded-full", isSel ? "bg-brand-fg/80" : "bg-brand")} />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected-day banner */}
      {selected && (
        <button onClick={() => setSelected(null)} className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
          <X className="size-3.5" /> Showing {etFullDate(selected + "T12:00:00Z")} · show all
        </button>
      )}

      {/* Grouped list */}
      {rows.length === 0 && (
        <div className="rounded-2xl border bg-surface p-8 text-center text-sm text-muted">
          <Camera className="mx-auto mb-2 size-6 text-muted-2" /> No shoots scheduled yet.
        </div>
      )}
      {rows.length > 0 && visible.length === 0 && (
        <p className="px-1 text-sm text-muted">No shoots for the selected photographers.</p>
      )}
      {selected && (byDay.get(selected)?.length ?? 0) === 0 && (
        <p className="text-sm text-muted">No shoots on this day.</p>
      )}
      {groups.map((day) => {
        const items = byDay.get(day) ?? [];
        if (items.length === 0) return null;
        return (
          <section key={day}>
            <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-2">
              {etFullDate(day + "T12:00:00Z")} · {items.length}
            </div>
            <div className="space-y-2">
              {items.map((r) => <ShootRowCard key={r.id} r={r} showWho={showWho} as={viewAs?.id ?? null} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ShootRowCard({ r, showWho, as }: { r: MyShootRow; showWho: boolean; as: string | null }) {
  const types = r.deliverableTypes.map((t) => DELIVERABLE_META[t]?.label ?? t).slice(0, 4);
  return (
    <Link
      href={as ? `/shoot/${r.id}?as=${as}` : `/shoot/${r.id}`}
      className="flex items-center gap-3 rounded-2xl border bg-surface p-3 transition-colors hover:border-brand/40 hover:bg-surface-2/50 sm:p-4"
    >
      {/* Property thumbnail: Street View of the address until the photos are
          live on Aryeo, then the listing's first image (server-side swap). */}
      {r.thumbUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={r.thumbUrl}
          alt={r.thumbKind === "aryeo" ? `First listing photo of ${r.street}` : `Street View of ${r.street}`}
          loading="lazy"
          className="h-16 w-24 shrink-0 rounded-xl border border-border object-cover sm:h-[4.5rem] sm:w-28"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-brand">{r.whenISO ? etTime(r.whenISO) : "—"}</span>
          {r.completed && <Badge color={PALETTE.green}><CheckCircle2 className="mr-0.5 inline size-3" /> Complete</Badge>}
          {!r.completed && r.uploaded && <Badge color={PALETTE.blue}><UploadIcon className="mr-0.5 inline size-3" /> Uploaded</Badge>}
        </div>
        <div className="mt-0.5 truncate font-semibold">{r.street}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
          <MapPin className="size-3.5 shrink-0" />
          <span className="truncate">{r.clientName}{showWho && r.photographerName ? ` · ${r.photographerName}` : ""}</span>
        </div>
        {types.length > 0 && <div className="mt-1.5 text-xs text-muted-2">{types.join(" · ")}</div>}
      </div>
      <ChevronRight className="size-5 shrink-0 text-muted-2" />
    </Link>
  );
}
