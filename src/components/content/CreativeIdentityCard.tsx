"use client";

import { useTransition } from "react";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { rebuildCreativeIdentityAction } from "@/app/content/actions";
import type { IdentityItem, StoredCreativeIdentity } from "@/lib/contentPolicy/creativeIdentity";

// ---------------------------------------------------------------------------
// CREATIVE IDENTITY CARD (Oct 14 2026), on the staff Strategy tab. Read-only:
// the profile is built and approved automatically from the approved strategy
// (src/lib/creativeIdentity.ts); "Rebuild" runs that again now. Staff only.
// ---------------------------------------------------------------------------

export type CreativeIdentityUi = {
  identity: StoredCreativeIdentity; builtFromVersionNo: number | null; stale: boolean; derivedAt: string | null;
  /** Oct 27 2026: the style inspirations the AI kept from their calls (identity.style_inspirations facts). */
  styleInspirations?: string[];
};

const HUMOR: Record<string, string> = { none: "None", dry: "Dry", warm: "Warm", playful: "Playful", outrageous: "Outrageous" };
const COMEDY: Record<string, string> = { no_acting: "No acting", light_bits: "Light bits", full_skits: "Full skits" };

function Items({ label, items }: { label: string; items: IdentityItem[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="text-[11px] font-semibold text-muted">{label}</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((x, i) => (
          <li key={i} className="text-[12px]">
            {x.text} <span className="text-[10px] text-muted-2">({x.basis === "stated" ? "stated" : "suggested"} · {x.source})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CreativeIdentityCard({ enrollmentId, data, hasApprovedStrategy }: { enrollmentId: string; data: CreativeIdentityUi | null; hasApprovedStrategy: boolean }) {
  const [busy, start] = useTransition();
  const { toast, show } = useToast();
  const rebuild = () => start(async () => { const r = await rebuildCreativeIdentityAction(enrollmentId); show(r.ok ? "ok" : "err", r.message); });
  const ci = data?.identity ?? null;
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      {toast}
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-3.5 text-muted-2" />
        <h3 className="flex-1 text-sm font-semibold">Creative identity</h3>
        <span className="text-[11px] text-muted-2">
          {ci ? `built automatically${data?.builtFromVersionNo ? ` from strategy v${data.builtFromVersionNo}` : ""}${data?.stale ? " · an older strategy, rebuilding soon" : ""}` : hasApprovedStrategy ? "building automatically" : "built once a strategy is approved"}
        </span>
        {hasApprovedStrategy && (
          <button disabled={busy} onClick={rebuild} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted hover:bg-surface-2 disabled:opacity-50">
            {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}Rebuild
          </button>
        )}
      </div>
      {ci && (
        <div className="mt-2 space-y-2">
          <p className="text-[12px]">
            <span className="text-muted">Humour:</span> {HUMOR[ci.humorStyle] ?? ci.humorStyle} · <span className="text-muted">Comedy:</span> {COMEDY[ci.comedyComfort] ?? ci.comedyComfort} · <span className="text-muted">Energy:</span> {ci.onCameraEnergy}
            {ci.toneWords.length ? <> · <span className="text-muted">Tone:</span> {ci.toneWords.join(", ")}</> : null}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Items label="Boundaries" items={ci.boundaries} />
            <Items label="Real interests" items={ci.interests} />
            <Items label="Formats they like" items={ci.formatsLiked} />
            <Items label="Formats they avoid" items={ci.formatsAvoided} />
            <Items label="Filming constraints" items={ci.filmingConstraints} />
            <Items label="Style inspirations" items={(data?.styleInspirations ?? []).map((text) => ({ text, basis: "stated" as const, source: "their calls" }))} />
          </div>
          <p className="text-[10px] text-muted-2">Stated items are the client&rsquo;s own; suggested ones are inferred and never treated as facts. Every script, topic idea and revision is written inside these limits.</p>
        </div>
      )}
    </div>
  );
}
