import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft, Mail, Phone, Camera, Palette, Star, CalendarDays,
  Upload, MessageSquare, Clock, ArrowRight,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { TeamTextComposer } from "@/components/team/TeamTextComposer";
import { PaySettings } from "@/components/team/PaySettings";
import { getTeamMemberDetail } from "@/lib/queries";
import { stageMeta, ROLE_META } from "@/lib/pipeline";
import { etDateTime, etMonthDay, etTime, isTodayET } from "@/lib/datetime";

export const dynamic = "force-dynamic";

export default async function TeamMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getTeamMemberDetail(id);
  if (!data) notFound();
  const { member, upcoming, recentShoots, editingNow, feedback, uploads, kpis } = data;
  const role = ROLE_META[member.role];
  const first = member.name.split(" ")[0];

  // Build a one-click morning well-wish if they have a shoot today.
  const todayShoot = upcoming.find((a) => a.startAt && isTodayET(a.startAt));
  const morningGreeting = todayShoot
    ? `Good morning ${first}! You're set for ${todayShoot.project.title} at ${etTime(todayShoot.startAt!)} today. Have a great shoot 📸`
    : null;

  return (
    <div>
      <div className="border-b border-border px-4 py-4 sm:px-6">
        <Link href="/team" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="size-4" /> All team
        </Link>
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={member.name} size={56} color={member.avatarColor} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{member.name}</h1>
              <Badge color={role.color} soft={`${role.color}1a`}>{role.label}</Badge>
              {member.title && <span className="text-sm text-muted">{member.title}</span>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              {member.email && (
                <a href={`mailto:${member.email}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                  <Mail className="size-3.5" /> {member.email}
                </a>
              )}
              {member.phone && (
                <a href={`tel:${member.phone}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                  <Phone className="size-3.5" /> {member.phone}
                </a>
              )}
            </div>
          </div>
          <div className="ml-auto flex gap-2">
            <Stat icon={<Camera className="size-4" />} label="Shoots / mo" value={String(kpis.shootsThisMonth)} />
            <Stat icon={<Palette className="size-4" />} label="Edits / mo" value={String(kpis.editsThisMonth)} />
            <Stat
              icon={<Star className="size-4" />}
              label={`Rating${kpis.ratingCount ? ` (${kpis.ratingCount})` : ""}`}
              value={kpis.avgRating != null ? kpis.avgRating.toFixed(1) : "—"}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* MAIN: schedule + work */}
        <div className="space-y-6">
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><CalendarDays className="size-4 text-muted" /> Upcoming schedule</h2>
            <div className="space-y-2">
              {upcoming.length === 0 && <p className="text-sm text-muted">No upcoming shoots assigned.</p>}
              {upcoming.map((a) => (
                <Link key={a.id} href={`/projects/${a.project.id}`} className="flex items-center gap-3 rounded-xl border bg-surface p-3 hover:bg-surface-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                    <Camera className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{a.project.title}</div>
                    <div className="truncate text-xs text-muted">{a.project.client.name}</div>
                  </div>
                  <div className="shrink-0 text-right text-xs">
                    <div className={isTodayET(a.startAt ?? new Date(0)) ? "font-semibold text-brand" : "text-muted"}>
                      {a.startAt ? etDateTime(a.startAt) : "Unscheduled"}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>

          {editingNow.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Palette className="size-4 text-muted" /> In their edit queue</h2>
              <div className="space-y-2">
                {editingNow.map((p) => {
                  const stage = stageMeta(p.status);
                  return (
                    <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center gap-3 rounded-xl border bg-surface p-3 hover:bg-surface-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{p.title}</span>
                          <Badge color={stage.color} soft={stage.soft}>{stage.short}</Badge>
                        </div>
                        <div className="truncate text-xs text-muted">{p.client.name}</div>
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted">
                        <Clock className="size-3" /> {p.deliveryDue ? `Due ${etMonthDay(p.deliveryDue)}` : "No due date"}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          {recentShoots.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Camera className="size-4 text-muted" /> Recent shoots</h2>
              <div className="space-y-2">
                {recentShoots.map((p) => {
                  const stage = stageMeta(p.status);
                  return (
                    <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center gap-3 rounded-xl border bg-surface p-3 hover:bg-surface-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{p.title}</span>
                          <Badge color={stage.color} soft={stage.soft}>{stage.short}</Badge>
                        </div>
                        <div className="truncate text-xs text-muted">{p.client.name}{p.shootDate ? ` · ${etMonthDay(p.shootDate)}` : ""}</div>
                      </div>
                      <ArrowRight className="size-4 shrink-0 text-muted" />
                    </Link>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        {/* SIDEBAR: text + uploads + feedback */}
        <div className="space-y-6">
          <section className="rounded-2xl border bg-surface">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3">
              <MessageSquare className="size-4 text-brand" />
              <h2 className="text-sm font-semibold">Text {first}</h2>
            </div>
            <div className="px-5 py-4">
              <TeamTextComposer
                memberId={member.id}
                firstName={first}
                hasPhone={!!member.phone}
                morningGreeting={morningGreeting}
              />
            </div>
          </section>

          {(member.role === "PHOTOGRAPHER" || member.isServiceProvider) && (
            <PaySettings
              memberId={member.id}
              homeAddress={member.homeAddress}
              payPercent={member.payPercent}
              payFloor={member.payFloor}
              mileageRate={member.mileageRate}
              homeRadiusMi={member.homeRadiusMi}
            />
          )}

          {uploads.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Upload className="size-4 text-muted" /> Recent uploads</h2>
              <div className="rounded-2xl border bg-surface">
                {uploads.map((u) => (
                  <Link key={u.id} href={`/projects/${u.project.id}`} className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm last:border-0 hover:bg-surface-2">
                    <Upload className="size-3.5 shrink-0 text-muted-2" />
                    <span className="min-w-0 flex-1 truncate">{u.originalName}</span>
                    <span className="shrink-0 truncate text-xs text-muted">{u.project.title.split(",")[0]}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {feedback.length > 0 && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Star className="size-4 text-warning" /> Feedback on their work</h2>
              <div className="rounded-2xl border bg-surface">
                {feedback.map((f) => (
                  <div key={f.id} className="border-b border-border px-4 py-3 last:border-0">
                    <div className="mb-0.5 text-xs font-medium text-warning">
                      {f.rating ? `${f.rating}/5` : ""}{f.sentiment ? `${f.rating ? " · " : ""}${f.sentiment.toLowerCase()}` : ""}
                    </div>
                    <p className="text-sm text-foreground/90">{f.body}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-surface px-3 py-2 text-center">
      <div className="flex items-center justify-center gap-1 text-muted-2">{icon}</div>
      <div className="mt-0.5 text-sm font-semibold">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-2">{label}</div>
    </div>
  );
}
