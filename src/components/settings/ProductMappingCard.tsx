"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Save } from "lucide-react";
import { saveProductMapping } from "@/app/settings/products/actions";
import { VIDEO_TYPES } from "@/lib/videoStyles";

export type ProductCard = {
  id: string;
  title: string;
  aryeoType: string | null; // MAIN | ADDON (Aryeo's own hint)
  description: string | null;
  orders: number;
  tags: string[];
  priceRange: string | null;
  types: string[]; // current mapping, or the parser's suggestion when unmapped
  addonTypes: string[]; // subset of types that are post-shoot add-on work
  videoTier: string | null;
  videoQuantity: number | null;
  videoStyle: string | null; // style-guide key (Product.videoStyle) — null until a human picks one
  serviceKind: string; // service | addon (legacy product-level)
  isMapped: boolean;
  mappedBy: string | null;
};

const TYPE_OPTIONS: { key: string; label: string }[] = [
  { key: "PHOTOS", label: "Photos" },
  { key: "VIDEO", label: "Video" },
  { key: "SOCIAL_REEL", label: "Social reel" },
  { key: "DRONE_PHOTO", label: "Drone photos" },
  { key: "DRONE_VIDEO", label: "Drone video" },
  { key: "FLOORPLAN", label: "Floor plan" },
  { key: "ZILLOW_3D", label: "Zillow 3D" },
  { key: "MATTERPORT_3D", label: "Matterport" },
  { key: "TWILIGHT", label: "Twilight" },
  { key: "VIRTUAL_STAGING", label: "Virtual staging" },
  { key: "HEADSHOT", label: "Headshots" },
  { key: "OTHER", label: "Other" },
];

// THE VIDEO STYLE — the Style Guide's types (src/lib/videoStyles.ts headings)
// keyed by the shared-contract key stored in Product.videoStyle and resolved
// onto Deliverable.videoStyle at sync. Jordan, Sep 2 2026: "an agent intro
// should be added to standard products in the product categories settings…
// so we can identify that" — the category alone ("Social Reel") lost the
// product name, so an agent-intro reel reached the editor as a plain reel.
// `name` must match VIDEO_TYPES[].name so the select IS the style guide;
// `inGuide` flags a contract key the guide hasn't written up yet (Premium
// Cinematic Video is a live product without a page). Mirrors
// VIDEO_STYLE_TIER in actions.ts the way TYPE_OPTIONS mirrors VALID_TYPES.
const VIDEO_STYLE_OPTIONS: { key: string; name: string; tier: string; inGuide: boolean }[] = [
  { key: "standard_reel", name: "Standard Reel", tier: "standard" },
  { key: "standard_reel_agent_intro", name: "Standard Reel with Agent Intro", tier: "standard" },
  { key: "standard_cinematic", name: "Standard Cinematic Video", tier: "standard" },
  { key: "premium_social_reel", name: "Premium Social Media Reel", tier: "premium" },
  { key: "premium_cinematic", name: "Premium Cinematic Video", tier: "premium" },
  { key: "personal_branding", name: "Personal Branding Reel", tier: "personal_branding" },
].map((o) => ({ ...o, inGuide: VIDEO_TYPES.some((t) => t.name === o.name) }));
const styleName = (key: string | null) => VIDEO_STYLE_OPTIONS.find((o) => o.key === key)?.name ?? null;

// The "Agent on Camera" add-on produces no video — it upgrades the reel on
// the same order to agent-intro, so it gets the style control without a
// video type. (Same test as STYLE_UPGRADE_ADDON_RE in actions.ts.)
const STYLE_UPGRADE_ADDON_RE = /agent\s*on\s*camera/i;
// "Same Day Photo Delivery" / "Same Day 2D Floor-Plan Delivery" are RUSH
// add-ons: they change when the photos/floor plan are due, not what is made.
// Derived from the name so a human mapping them sees why the line matters
// even though it produces nothing new.
const SAME_DAY_RE = /same[\s-]*day/i;
const sameDayTarget = (title: string) =>
  /floor[\s-]?plan/i.test(title) ? "floor plan" : /photo/i.test(title) ? "photos" : "deliverables";

// A starting point from the Aryeo name + tags (Aryeo's own tags are explicit:
// "Standard Reel w/ Agent Intro", "Premium Reel", "Premium MLS Video",
// "Monthly Social Content"). Offered as a one-tap suggestion, NEVER
// pre-selected: most cards already read "mapped" from the category backfill,
// and a pre-filled select would look saved when it isn't. Reel words win over
// MLS/cinematic words because on a two-video bundle the style names the reel.
function suggestStyle(card: ProductCard): string | null {
  const text = `${card.title} ${card.tags.join(" ")}`.toLowerCase();
  if (/monthly social|personal.?brand/.test(text)) return "personal_branding";
  if (/agent.?intro|w\/\s*agent|agent on camera/.test(text)) return "standard_reel_agent_intro";
  if (/premium (social|reel)|influencer/.test(text)) return "premium_social_reel";
  if (/premium (cinematic|mls)/.test(text)) return "premium_cinematic";
  if (/\breel\b/.test(text)) return "standard_reel";
  if (/cinematic|mls video/.test(text)) return "standard_cinematic";
  return null;
}

export function ProductMappingCard({ card }: { card: ProductCard }) {
  const [types, setTypes] = useState<Set<string>>(new Set(card.types));
  const [tier, setTier] = useState(card.videoTier ?? "standard");
  const [vidQty, setVidQty] = useState(card.videoQuantity ?? 1);
  const [style, setStyle] = useState<string | null>(card.videoStyle);
  // Per-PART kind — a bundle's photos are shoot work while its virtual
  // staging is post-shoot editing (Jordan, Aug 24). Default: Aryeo add-on
  // products start with every part as add-on.
  const [addons, setAddons] = useState<Set<string>>(
    new Set(card.addonTypes.length ? card.addonTypes : card.serviceKind === "addon" ? card.types : []),
  );
  const [msg, setMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState(card.isMapped);
  const [busy, start] = useTransition();
  const [showDesc, setShowDesc] = useState(false);

  const hasVideo = types.has("VIDEO") || types.has("SOCIAL_REEL") || types.has("DRONE_VIDEO");
  const isUpgradeAddon = STYLE_UPGRADE_ADDON_RE.test(card.title);
  const isSameDay = SAME_DAY_RE.test(card.title);
  const showStyle = hasVideo || isUpgradeAddon;
  const suggested = showStyle && !style ? suggestStyle(card) : null;
  const twoVideoParts = types.has("SOCIAL_REEL") && (types.has("VIDEO") || types.has("DRONE_VIDEO"));
  const toggle = (k: string) => {
    const next = new Set(types);
    if (next.has(k)) next.delete(k); else next.add(k);
    setTypes(next);
    setSaved(false);
  };
  // Picking a style pins the tier it belongs to (the server does the same),
  // so the tier select can't contradict the style guide.
  const pickStyle = (key: string | null) => {
    setStyle(key);
    const t = VIDEO_STYLE_OPTIONS.find((o) => o.key === key)?.tier;
    if (t) setTier(t);
    setSaved(false);
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{card.title}</span>
            {card.aryeoType && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{card.aryeoType === "ADDON" ? "Aryeo: add-on" : card.aryeoType === "LEGACY" ? "retired — still on orders" : "Aryeo: main"}</span>}
            {isSameDay && <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">same-day rush</span>}
            {isUpgradeAddon && <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">upgrades the reel</span>}
            {card.priceRange && <span className="text-[11px] text-muted-2">{card.priceRange}</span>}
            {card.orders > 0 && <span className="text-[11px] text-muted-2">{card.orders} order{card.orders === 1 ? "" : "s"}</span>}
            {saved && <span className="inline-flex items-center gap-1 rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-medium text-success"><Check className="size-2.5" /> mapped</span>}
          </div>
          {card.description && (
            <button onClick={() => setShowDesc((v) => !v)} className="mt-0.5 text-left text-xs text-muted hover:text-foreground">
              {showDesc ? card.description : `${card.description.slice(0, 140)}${card.description.length > 140 ? "… (tap for more)" : ""}`}
            </button>
          )}
          {isSameDay && (
            <p className="mt-1 text-[11px] text-warning">
              Rush add-on — same-day turnaround for the {sameDayTarget(card.title)} on this order. It changes <em>when</em>, not <em>what</em>: no extra media is produced.
            </p>
          )}
          {isUpgradeAddon && (
            <p className="mt-1 text-[11px] text-muted">
              Makes no video of its own — it upgrades the reel on the same order. Pick the style that reel becomes (Standard Reel → Standard Reel with Agent Intro) so the editor gets the intro script + notes.
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {TYPE_OPTIONS.map((t) => (
          <button
            key={t.key}
            onClick={() => toggle(t.key)}
            className={types.has(t.key)
              ? "rounded-lg border border-brand/40 bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand"
              : "rounded-lg border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-foreground"}
          >
            {t.label}
          </button>
        ))}
      </div>
      {types.size === 0 && (
        <p className="mt-1.5 text-[11px] text-warning">Produces nothing — right for fees, discounts, and services that add no media.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {showStyle && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Video style
            <select value={style ?? ""} onChange={(e) => pickStyle(e.target.value || null)}
              className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand">
              <option value="">— not set —</option>
              {VIDEO_STYLE_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>{o.name}{o.inGuide ? "" : " (no style-guide page yet)"}</option>
              ))}
            </select>
          </label>
        )}
        {hasVideo && (
          <label className="flex items-center gap-1.5 text-xs text-muted" title={style ? "Tier follows the video style" : undefined}>
            Video tier
            <select value={tier} disabled={!!style} onChange={(e) => { setTier(e.target.value); setSaved(false); }}
              className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand disabled:opacity-60">
              <option value="standard">Standard</option>
              <option value="premium">Premium</option>
              <option value="personal_branding">Personal branding</option>
            </select>
          </label>
        )}
        {hasVideo && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Videos per order
            <input
              type="number" min={1} max={20} value={vidQty}
              onChange={(e) => { setVidQty(Math.max(1, Math.min(20, Number(e.target.value) || 1))); setSaved(false); }}
              className="w-16 rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand"
            />
          </label>
        )}
        {showStyle && (suggested || !style || twoVideoParts) && (
          <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            {suggested && (
              <button onClick={() => pickStyle(suggested)} className="text-brand hover:underline">
                Suggested from the name: {styleName(suggested)} — use it
              </button>
            )}
            {!style && !suggested && (
              <span className="text-warning">No video style yet — the editor brief and Style Guide can only name this video once it has one.</span>
            )}
            {twoVideoParts && (
              <span className="text-muted-2">Bundle with a reel and a horizontal video — the style describes the reel.</span>
            )}
          </div>
        )}
        {types.size > 0 && (
          <div className="flex w-full flex-col gap-1">
            {[...types].map((t) => (
              <div key={t} className="flex items-center gap-2 text-xs">
                <span className="w-28 shrink-0 text-muted">{TYPE_OPTIONS.find((o) => o.key === t)?.label ?? t}</span>
                <div className="flex overflow-hidden rounded-lg border border-border">
                  <button
                    onClick={() => { const n = new Set(addons); n.delete(t); setAddons(n); setSaved(false); }}
                    className={!addons.has(t) ? "bg-brand px-2 py-0.5 text-[11px] font-semibold text-white" : "px-2 py-0.5 text-[11px] text-muted hover:bg-surface-2"}
                  >
                    At the shoot
                  </button>
                  <button
                    onClick={() => { const n = new Set(addons); n.add(t); setAddons(n); setSaved(false); }}
                    className={addons.has(t) ? "bg-brand px-2 py-0.5 text-[11px] font-semibold text-white" : "px-2 py-0.5 text-[11px] text-muted hover:bg-surface-2"}
                  >
                    Post-shoot add-on
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          disabled={busy}
          onClick={() => start(async () => {
            const r = await saveProductMapping(card.id, {
              types: [...types],
              addonTypes: [...addons].filter((t) => types.has(t)),
              videoTier: hasVideo ? tier : null,
              videoQuantity: hasVideo ? vidQty : null,
              videoStyle: showStyle ? style : null,
            });
            setMsg(r.message);
            if (r.ok) setSaved(true);
          })}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          Save &amp; apply
        </button>
      </div>
      {msg && <p className="mt-2 text-[11px] text-muted">{msg}</p>}
    </div>
  );
}
