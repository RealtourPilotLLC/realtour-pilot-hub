"use client";

import { useState, useMemo, Fragment } from "react";
import Link from "next/link";
import { Star, FolderOpen, Film, Camera, Search, ArrowUpDown, Layers } from "lucide-react";
import { StageSelector } from "@/components/project/StageSelector";
import { Avatar } from "@/components/ui/Avatar";
import { PRIORITY_META } from "@/lib/pipeline";
import { etMonthDay, etDaysAgo, etDayKey, etDate } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import type { ProjectStatus } from "@prisma/client";
import type { TrackerRow } from "@/lib/tracker";

type Board = "all" | "video" | "photo";
type SortKey = "due" | "shoot" | "priority";
type StatusGroup = "undelivered" | "editing" | "review" | "delivered";

const PRANK: Record<string, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
const STARS: Record<string, number> = { URGENT: 3, HIGH: 2, NORMAL: 1, LOW: 1 };

// Which workflow bucket a status belongs to. CANCELLED → "other" (hidden from
// the three tabs).
const STATUS_GROUP: Record<string, StatusGroup | "other"> = {
  BOOKED: "undelivered", SCHEDULED: "undelivered", SHOT: "undelivered", ON_HOLD: "undelivered",
  EDITING: "editing", REVISION: "editing",
  REVIEW: "review",
  DELIVERED: "delivered",
  CANCELLED: "other",
};
const STATUS_TABS: { key: StatusGroup; label: string }[] = [
  { key: "undelivered", label: "Undelivered" },
  { key: "editing", label: "In editing" },
  { key: "review", label: "Review / QC" },
  { key: "delivered", label: "Delivered" },
];

function ms(iso: string | null, fallback = Infinity) {
  return iso ? new Date(iso).getTime() : fallback;
}

// A date cell — month/day in ET, reddened when overdue (and not delivered).
function DateCell({ iso, overdueCheck }: { iso: string | null; overdueCheck?: boolean }) {
  if (!iso) return <span className="text-muted-2">—</span>;
  const overdue = overdueCheck && etDaysAgo(new Date(iso)) > 0;
  return (
    <span className={cn("whitespace-nowrap tabular-nums", overdue ? "font-semibold text-danger" : "text-foreground/80")}>
      {etMonthDay(iso)}
    </span>
  );
}

function TypePill({ row }: { row: TrackerRow }) {
  if (row.kind === "video") {
    const premium = row.videoTier === "Premium";
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
          premium ? "bg-[#8b5cf6]/15 text-[#a78bfa]" : "bg-surface-2 text-foreground/80",
        )}
      >
        <Film className="size-3" /> {row.videoTier}
      </span>
    );
  }
  if (row.kind === "photo") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-success/10 px-1.5 py-0.5 text-[11px] font-semibold text-success">
        <Camera className="size-3" /> Photo
      </span>
    );
  }
  return <span className="text-xs text-muted-2">—</span>;
}

function Priority({ priority }: { priority: string }) {
  const meta = PRIORITY_META[priority as keyof typeof PRIORITY_META] ?? PRIORITY_META.NORMAL;
  const n = STARS[priority] ?? 1;
  return (
    <span className="inline-flex items-center gap-0.5" title={meta.label}>
      {[0, 1, 2].map((i) => (
        <Star
          key={i}
          className="size-3.5"
          style={i < n ? { color: meta.color, fill: meta.color } : { color: "var(--muted-2)" }}
        />
      ))}
    </span>
  );
}

function Assignee({ name, color }: { name: string | null; color: string | null }) {
  if (!name) return <span className="text-xs text-muted-2">Unassigned</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Avatar name={name} color={color ?? "#6366f1"} size={20} />
      <span className="truncate text-xs text-foreground/80">{name}</span>
    </span>
  );
}

function FileLinks({ row }: { row: TrackerRow }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <a
        href={row.rawUrl}
        target="_blank"
        rel="noopener noreferrer"
        title="RAW footage folder (Dropbox)"
        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2/50 px-1.5 py-0.5 text-[11px] text-muted hover:text-foreground"
      >
        <FolderOpen className="size-3" /> RAW
      </a>
      <a
        href={row.finalUrl}
        target="_blank"
        rel="noopener noreferrer"
        title="Final footage folder (Dropbox)"
        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2/50 px-1.5 py-0.5 text-[11px] text-muted hover:text-foreground"
      >
        <FolderOpen className="size-3" /> Final
      </a>
    </span>
  );
}

// Heading for a shoot-date group in the Undelivered tab. Key is an ET day "key"
// (yyyy-mm-dd) or "none" for shoots with no date yet.
function groupLabel(key: string): string {
  if (key === "none") return "No shoot date";
  const d = new Date(key + "T12:00:00Z");
  const rel = etDaysAgo(d);
  if (rel === 0) return "Today";
  if (rel === -1) return "Tomorrow";
  if (rel === 1) return "Yesterday";
  return etDate(d);
}

type AssigneeKind = "photographer" | "editor";

function DesktopRow({ r, assignee }: { r: TrackerRow; assignee: AssigneeKind }) {
  return (
    <tr className="group transition-colors hover:bg-surface-2/40">
      <td className="max-w-[260px] px-4 py-2.5">
        <Link href={`/projects/${r.id}`} className="block truncate font-medium hover:text-brand">
          {r.street}
        </Link>
        {r.client && <div className="truncate text-xs text-muted">{r.client}</div>}
      </td>
      <td className="px-3 py-2.5"><TypePill row={r} /></td>
      <td className="max-w-[180px] px-3 py-2.5"><span className="block truncate text-xs text-foreground/80">{r.details}</span></td>
      <td className="px-3 py-2.5"><StageSelector projectId={r.id} status={r.status as ProjectStatus} /></td>
      <td className="px-3 py-2.5 text-xs"><DateCell iso={r.shootISO} /></td>
      <td className="px-3 py-2.5 text-xs"><DateCell iso={r.dueISO} overdueCheck={!r.deliveredISO} /></td>
      <td className="px-3 py-2.5"><Priority priority={r.priority} /></td>
      <td className="max-w-[140px] px-3 py-2.5"><Assignee name={assignee === "editor" ? r.editor : r.photographer} color={assignee === "editor" ? r.editorColor : r.photographerColor} /></td>
      <td className="px-3 py-2.5"><FileLinks row={r} /></td>
    </tr>
  );
}

function MobileCard({ r, assignee }: { r: TrackerRow; assignee: AssigneeKind }) {
  return (
    <div className="panel-shadow rounded-2xl border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <Link href={`/projects/${r.id}`} className="min-w-0 font-medium leading-snug hover:text-brand">
          <span className="block truncate">{r.street}</span>
          {r.client && <span className="block truncate text-xs font-normal text-muted">{r.client}</span>}
        </Link>
        <Priority priority={r.priority} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <TypePill row={r} />
        <span className="truncate text-xs text-muted">{r.details}</span>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <StageSelector projectId={r.id} status={r.status as ProjectStatus} />
        <Assignee name={assignee === "editor" ? r.editor : r.photographer} color={assignee === "editor" ? r.editorColor : r.photographerColor} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5 text-xs">
        <span className="inline-flex items-center gap-3 text-muted">
          <span>Shoot <DateCell iso={r.shootISO} /></span>
          <span>Due <DateCell iso={r.dueISO} overdueCheck={!r.deliveredISO} /></span>
        </span>
        <FileLinks row={r} />
      </div>
    </div>
  );
}

export function ProjectTracker({
  rows,
  showBoards = true,
  showStatusTabs = true,
  defaultStatus = "undelivered",
  assignee = "photographer",
  emptyLabel = "No projects.",
}: {
  rows: TrackerRow[];
  showBoards?: boolean;
  showStatusTabs?: boolean;
  defaultStatus?: StatusGroup;
  assignee?: "photographer" | "editor";
  emptyLabel?: string;
}) {
  const [board, setBoard] = useState<Board>("all");
  const [statusTab, setStatusTab] = useState<StatusGroup>(defaultStatus);
  const [sort, setSort] = useState<SortKey>("due");
  const [q, setQ] = useState("");

  const counts = useMemo(
    () => ({
      all: rows.length,
      video: rows.filter((r) => r.kind === "video").length,
      photo: rows.filter((r) => r.kind === "photo").length,
    }),
    [rows],
  );

  // Filter by type board first; status-tab counts then reflect that board.
  const boardFiltered = useMemo(
    () => (showBoards && board !== "all" ? rows.filter((r) => r.kind === board) : rows),
    [rows, board, showBoards],
  );
  const statusCounts = useMemo(
    () => ({
      undelivered: boardFiltered.filter((r) => STATUS_GROUP[r.status] === "undelivered").length,
      editing: boardFiltered.filter((r) => STATUS_GROUP[r.status] === "editing").length,
      review: boardFiltered.filter((r) => STATUS_GROUP[r.status] === "review").length,
      delivered: boardFiltered.filter((r) => STATUS_GROUP[r.status] === "delivered").length,
    }),
    [boardFiltered],
  );

  const visible = useMemo(() => {
    let list = boardFiltered;
    if (showStatusTabs) list = list.filter((r) => STATUS_GROUP[r.status] === statusTab);
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter(
        (r) =>
          r.title.toLowerCase().includes(needle) ||
          (r.client ?? "").toLowerCase().includes(needle) ||
          (r.photographer ?? "").toLowerCase().includes(needle) ||
          (r.editor ?? "").toLowerCase().includes(needle),
      );
    }
    const sorted = [...list];
    if (sort === "priority") {
      sorted.sort((a, b) => (PRANK[a.priority] ?? 9) - (PRANK[b.priority] ?? 9) || ms(a.dueISO) - ms(b.dueISO));
    } else if (sort === "shoot") {
      sorted.sort((a, b) => ms(a.shootISO) - ms(b.shootISO));
    } else {
      sorted.sort((a, b) => ms(a.dueISO) - ms(b.dueISO));
    }
    return sorted;
  }, [boardFiltered, showStatusTabs, statusTab, sort, q]);

  // The Undelivered tab is grouped by shoot date (soonest first; undated last) so
  // it reads like a shoot schedule. Other tabs stay as one flat list.
  const grouped = showStatusTabs && statusTab === "undelivered";
  const groups = useMemo(() => {
    if (!grouped) return null;
    const map = new Map<string, TrackerRow[]>();
    for (const r of visible) {
      const key = r.shootISO ? etDayKey(new Date(r.shootISO)) : "none";
      const arr = map.get(key);
      if (arr) arr.push(r);
      else map.set(key, [r]);
    }
    return [...map.keys()]
      .sort((a, b) => (a === "none" ? 1 : b === "none" ? -1 : a.localeCompare(b)))
      .map((k) => ({ key: k, rows: map.get(k)! }));
  }, [grouped, visible]);

  const boards: { key: Board; label: string; icon: typeof Layers; n: number }[] = [
    { key: "all", label: "All", icon: Layers, n: counts.all },
    { key: "video", label: "Video", icon: Film, n: counts.video },
    { key: "photo", label: "Photo", icon: Camera, n: counts.photo },
  ];

  const assigneeHeader = assignee === "editor" ? "Editor" : "Photographer";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pt-1 sm:px-6">
        {showStatusTabs && (
          <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
            {STATUS_TABS.filter((t) => statusCounts[t.key] > 0 || t.key === statusTab).map((t) => {
              const active = statusTab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setStatusTab(t.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                    active ? "bg-brand text-white" : "text-muted hover:bg-surface-2 hover:text-foreground",
                  )}
                >
                  {t.label}
                  <span className={cn("rounded-full px-1.5 text-[10px]", active ? "bg-white/20" : "bg-surface-2")}>{statusCounts[t.key]}</span>
                </button>
              );
            })}
          </div>
        )}
        {showBoards && (
          <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
            {boards.map((b) => {
              const Icon = b.icon;
              const active = board === b.key;
              return (
                <button
                  key={b.key}
                  onClick={() => setBoard(b.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                    active ? "bg-brand text-white" : "text-muted hover:bg-surface-2 hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" /> {b.label}
                  <span className={cn("rounded-full px-1.5 text-[10px]", active ? "bg-white/20" : "bg-surface-2")}>{b.n}</span>
                </button>
              );
            })}
          </div>
        )}

        <label className="relative ml-auto flex items-center">
          <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-2" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search address, client, crew…"
            className="w-44 rounded-lg border border-border bg-surface py-1.5 pl-8 pr-3 text-xs outline-none focus:border-brand sm:w-60"
          />
        </label>

        <div className="relative inline-flex items-center">
          <ArrowUpDown className="pointer-events-none absolute left-2.5 size-3.5 text-muted-2" />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="cursor-pointer appearance-none rounded-lg border border-border bg-surface py-1.5 pl-8 pr-3 text-xs font-medium outline-none focus:border-brand"
          >
            <option value="due">By due date</option>
            <option value="shoot">By shoot date</option>
            <option value="priority">By priority</option>
          </select>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto scroll-thin px-4 pb-6 sm:px-6">
        {visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-surface p-10 text-center text-sm text-muted">{emptyLabel}</div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-hidden rounded-2xl border border-border bg-surface lg:block">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-2">
                    <th className="px-4 py-2.5 font-semibold">Property</th>
                    <th className="px-3 py-2.5 font-semibold">Type</th>
                    <th className="px-3 py-2.5 font-semibold">Details</th>
                    <th className="px-3 py-2.5 font-semibold">Status</th>
                    <th className="px-3 py-2.5 font-semibold">Shoot</th>
                    <th className="px-3 py-2.5 font-semibold">Due</th>
                    <th className="px-3 py-2.5 font-semibold">Priority</th>
                    <th className="px-3 py-2.5 font-semibold">{assigneeHeader}</th>
                    <th className="px-3 py-2.5 font-semibold">Files</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {groups
                    ? groups.map((g) => (
                        <Fragment key={g.key}>
                          <tr className="bg-surface-2/50">
                            <td colSpan={9} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                              {groupLabel(g.key)} <span className="text-muted-2/70">· {g.rows.length}</span>
                            </td>
                          </tr>
                          {g.rows.map((r) => <DesktopRow key={r.id} r={r} assignee={assignee} />)}
                        </Fragment>
                      ))
                    : visible.map((r) => <DesktopRow key={r.id} r={r} assignee={assignee} />)}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="space-y-2.5 lg:hidden">
              {groups
                ? groups.map((g) => (
                    <div key={g.key} className="space-y-2.5">
                      <div className="px-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                        {groupLabel(g.key)} <span className="text-muted-2/70">· {g.rows.length}</span>
                      </div>
                      {g.rows.map((r) => <MobileCard key={r.id} r={r} assignee={assignee} />)}
                    </div>
                  ))
                : visible.map((r) => <MobileCard key={r.id} r={r} assignee={assignee} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
