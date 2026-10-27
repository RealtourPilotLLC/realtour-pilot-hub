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

// Oct 27 2026 (Jordan: "creative identity, this could be looking a lot
// better. It's kind of confusing, small format"): body-size type, the four
// style readings as labelled rows, each list under its own heading, and a
// plain "they said it" / "our read" tag in place of "(stated · source)".
function Items({ label, items }: { label: string; items: IdentityItem[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-2">{label}</h4>
      <ul className="mt-1.5 space-y-1.5">
        {items.map((x, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-sm leading-relaxed">
            <span>{x.text}</span>
            <span className="text-xs text-muted-2" title={x.source}>{x.basis === "stated" ? "they said it" : "our read"}</span>
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
  const style: { label: string; value: string }[] = ci ? [
    { label: "Humour", value: HUMOR[ci.humorStyle] ?? ci.humorStyle },
    { label: "Comedy", value: COMEDY[ci.comedyComfort] ?? ci.comedyComfort },
    { label: "On-camera energy", value: ci.onCameraEnergy },
    ...(ci.toneWords.length ? [{ label: "Tone", value: ci.toneWords.join(", ") }] : []),
  ] : [];
  return (
    <section className="panel-shadow rounded-2xl border bg-surface px-5 py-4">
      {toast}
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-muted-2" />
        <h3 className="flex-1 text-[15px] font-semibold">Creative identity</h3>
        {hasApprovedStrategy && (
          <button disabled={busy} onClick={rebuild} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-50">
            {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}Rebuild
          </button>
        )}
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        How this client comes across on camera. Every script, topic idea and revision is written inside these limits.{" "}
        {ci ? `Built automatically${data?.builtFromVersionNo ? ` from strategy v${data.builtFromVersionNo}` : ""}${data?.stale ? "; the strategy changed, so it rebuilds soon" : ""}.` : hasApprovedStrategy ? "Building automatically." : "Built once a strategy is approved."}
      </p>
      {ci && (
        <div className="mt-4 space-y-5">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {style.map((r) => (
              <div key={r.label} className="flex flex-wrap items-baseline gap-x-2">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-2">{r.label}</dt>
                <dd className="text-sm">{r.value}</dd>
              </div>
            ))}
          </dl>
          <div className="grid gap-5 sm:grid-cols-2">
            <Items label="Boundaries" items={ci.boundaries} />
            <Items label="Real interests" items={ci.interests} />
            <Items label="Formats they like" items={ci.formatsLiked} />
            <Items label="Formats they avoid" items={ci.formatsAvoided} />
            <Items label="Filming constraints" items={ci.filmingConstraints} />
            <Items label="Style inspirations" items={(data?.styleInspirations ?? []).map((text) => ({ text, basis: "stated" as const, source: "their calls" }))} />
          </div>
          <p className="text-xs text-muted-2">&ldquo;They said it&rdquo; is the client&rsquo;s own words; &ldquo;our read&rdquo; is inferred and never treated as a fact.</p>
        </div>
      )}
    </section>
  );
}
