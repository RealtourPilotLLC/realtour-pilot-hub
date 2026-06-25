"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserRound, RefreshCw, Sparkles, ThumbsUp, ThumbsDown, MessageSquare, Repeat, Camera, Palette, ShieldCheck } from "lucide-react";
import { regenerateClientProfile } from "@/app/clients/actions";
import type { ClientProfile } from "@/lib/clientProfile";

const TOUCH: Record<string, { label: string; color: string }> = {
  high: { label: "High touch", color: "#d782ac" },
  medium: { label: "Medium touch", color: "#d4a95f" },
  low: { label: "Low touch", color: "#5cb98a" },
};

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="rounded-xl border bg-background/40 px-3 py-2 text-center">
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-2">{label}</div>
    </div>
  );
}

function Bullets({ icon, title, items }: { icon: React.ReactNode; title: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {icon} {title}
      </div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2 text-sm leading-relaxed text-foreground/90">
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand/60" />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ClientProfileCard({ clientId, profile, updatedAt }: { clientId: string; profile: ClientProfile | null; updatedAt: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  const touch = profile?.touchLevel ? TOUCH[profile.touchLevel] : null;

  function regen() {
    setErr("");
    start(async () => {
      const r = await regenerateClientProfile(clientId);
      if (r.ok) router.refresh();
      else setErr(r.message);
    });
  }

  return (
    <section className="overflow-hidden rounded-2xl border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg bg-brand-soft text-brand"><UserRound className="size-4" /></span>
        <h2 className="text-sm font-semibold">Working profile</h2>
        {touch && (
          <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: `${touch.color}22`, color: touch.color }}>
            {touch.label}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-2" title="Built only from info appropriate for the creative team">
          <ShieldCheck className="size-3.5 text-brand" /> creative-safe
        </span>
        <button
          onClick={regen}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} /> {pending ? "Building…" : profile ? "Refresh" : "Generate"}
        </button>
      </div>

      <div className="space-y-4 px-5 py-4">
        {!profile ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <Sparkles className="size-6 text-brand" />
            <p className="max-w-sm text-sm text-muted">
              Build an AI summary of who this client is to work with, from their messages, shoot debriefs, and revision history.
            </p>
            <button onClick={regen} disabled={pending} className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg disabled:opacity-50">
              <Sparkles className="size-4" /> {pending ? "Building…" : "Generate profile"}
            </button>
          </div>
        ) : (
          <>
            {profile.summary && <p className="text-sm leading-relaxed text-foreground/90">{profile.summary}</p>}

            <div className="grid grid-cols-3 gap-2">
              <Stat value={profile.stats.totalOrders} label="Orders" />
              <Stat value={profile.stats.revisions} label="Revisions" />
              <Stat value={profile.stats.inboundMsgs} label="Messages" />
            </div>

            {profile.workingStyle && (
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Working style</div>
                <p className="text-sm leading-relaxed text-foreground/90">{profile.workingStyle}</p>
              </div>
            )}
            {profile.communication && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"><MessageSquare className="size-3.5" /> Communication</div>
                <p className="text-sm leading-relaxed text-foreground/90">{profile.communication}</p>
              </div>
            )}
            {(profile.revisions?.summary || profile.revisions?.commonTypes?.length) && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"><Repeat className="size-3.5" /> Revisions</div>
                {profile.revisions.summary && <p className="text-sm leading-relaxed text-foreground/90">{profile.revisions.summary}</p>}
                {profile.revisions.commonTypes?.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {profile.revisions.commonTypes.map((t, i) => (
                      <span key={i} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{t}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {profile.brandStyle && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted"><Palette className="size-3.5" /> Brand & style</div>
                <p className="text-sm leading-relaxed text-foreground/90">{profile.brandStyle}</p>
              </div>
            )}
            <Bullets icon={<Camera className="size-3.5" />} title="Shoot notes" items={profile.shootNotes} />
            <Bullets icon={<UserRound className="size-3.5" />} title="About them" items={profile.aboutThem} />

            {(profile.dos?.length > 0 || profile.donts?.length > 0) && (
              <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
                {profile.dos?.length > 0 && (
                  <div>
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-success"><ThumbsUp className="size-3.5" /> Do</div>
                    <ul className="space-y-1">{profile.dos.map((d, i) => <li key={i} className="text-sm leading-relaxed text-foreground/90">{d}</li>)}</ul>
                  </div>
                )}
                {profile.donts?.length > 0 && (
                  <div>
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-danger"><ThumbsDown className="size-3.5" /> Avoid</div>
                    <ul className="space-y-1">{profile.donts.map((d, i) => <li key={i} className="text-sm leading-relaxed text-foreground/90">{d}</li>)}</ul>
                  </div>
                )}
              </div>
            )}

            {updatedAt && <div className="border-t border-border pt-2 text-[11px] text-muted-2">Updated {updatedAt}</div>}
          </>
        )}
        {err && <div className="text-xs text-danger">{err}</div>}
      </div>
    </section>
  );
}
