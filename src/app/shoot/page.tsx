import Link from "next/link";
import { Camera, ChevronRight, CheckCircle2, Upload as UploadIcon, MapPin } from "lucide-react";
import { listMyShoots, type MyShootRow } from "@/lib/shoot";
import { getCurrentUser } from "@/lib/auth/user";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { DELIVERABLE_META } from "@/lib/pipeline";
import { PALETTE } from "@/lib/palette";
import { etDaysAgo, etTime, etDateTime, etDate } from "@/lib/datetime";

export const dynamic = "force-dynamic";

export default async function MyShootsPage() {
  const user = await getCurrentUser();
  // Photographers see only their own shoots; owner/admin (and the open,
  // pre-cutover app) see everyone's.
  const scoped = user?.role === "PHOTOGRAPHER" && user.teamMemberId ? user.teamMemberId : null;
  const showWho = !scoped;

  const rows = await listMyShoots(scoped);

  const today: MyShootRow[] = [];
  const upcoming: MyShootRow[] = [];
  const recent: MyShootRow[] = [];
  for (const r of rows) {
    if (!r.whenISO) { recent.push(r); continue; }
    const d = etDaysAgo(new Date(r.whenISO));
    if (d === 0) today.push(r);
    else if (d < 0) upcoming.push(r);
    else recent.push(r);
  }
  today.sort((a, b) => (a.whenISO ?? "").localeCompare(b.whenISO ?? ""));
  upcoming.sort((a, b) => (a.whenISO ?? "").localeCompare(b.whenISO ?? ""));
  recent.sort((a, b) => (b.whenISO ?? "").localeCompare(a.whenISO ?? ""));

  return (
    <div>
      <PageHeader eyebrow="Field" title="My Shoots" subtitle={scoped ? "Your upcoming and recent shoots" : "All upcoming and recent shoots"} />
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-5 sm:px-6">
        {rows.length === 0 && (
          <div className="rounded-2xl border bg-surface p-8 text-center text-sm text-muted">
            <Camera className="mx-auto mb-2 size-6 text-muted-2" />
            No shoots scheduled yet.
          </div>
        )}
        <Bucket title="Today" rows={today} when="time" showWho={showWho} />
        <Bucket title="Upcoming" rows={upcoming} when="datetime" showWho={showWho} />
        <Bucket title="Recent" rows={recent} when="date" showWho={showWho} />
      </div>
    </div>
  );
}

function Bucket({ title, rows, when, showWho }: { title: string; rows: MyShootRow[]; when: "time" | "datetime" | "date"; showWho: boolean }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-2">{title} · {rows.length}</div>
      <div className="space-y-2">
        {rows.map((r) => <ShootRowCard key={r.id} r={r} when={when} showWho={showWho} />)}
      </div>
    </section>
  );
}

function ShootRowCard({ r, when, showWho }: { r: MyShootRow; when: "time" | "datetime" | "date"; showWho: boolean }) {
  const whenText =
    when === "time" ? (r.whenISO ? `Today · ${etTime(r.whenISO)}` : "Today")
    : when === "datetime" ? etDateTime(r.whenISO)
    : etDate(r.whenISO);
  const types = r.deliverableTypes.map((t) => DELIVERABLE_META[t]?.label ?? t).slice(0, 4);

  return (
    <Link
      href={`/shoot/${r.id}`}
      className="flex items-center gap-3 rounded-2xl border bg-surface p-4 transition-colors hover:border-brand/40 hover:bg-surface-2/50"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-brand">{whenText}</span>
          {r.completed && <Badge color={PALETTE.green}><CheckCircle2 className="mr-0.5 inline size-3" /> Complete</Badge>}
          {!r.completed && r.uploaded && <Badge color={PALETTE.blue}><UploadIcon className="mr-0.5 inline size-3" /> Uploaded</Badge>}
        </div>
        <div className="mt-0.5 truncate font-semibold">{r.street}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
          <MapPin className="size-3.5 shrink-0" />
          <span className="truncate">{r.clientName}{showWho && r.photographerName ? ` · ${r.photographerName}` : ""}</span>
        </div>
        {types.length > 0 && (
          <div className="mt-1.5 text-xs text-muted-2">{types.join(" · ")}</div>
        )}
      </div>
      <ChevronRight className="size-5 shrink-0 text-muted-2" />
    </Link>
  );
}
