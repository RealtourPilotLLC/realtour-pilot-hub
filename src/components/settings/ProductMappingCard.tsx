"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Save } from "lucide-react";
import { saveProductMapping } from "@/app/settings/products/actions";

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

export function ProductMappingCard({ card }: { card: ProductCard }) {
  const [types, setTypes] = useState<Set<string>>(new Set(card.types));
  const [tier, setTier] = useState(card.videoTier ?? "standard");
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
  const toggle = (k: string) => {
    const next = new Set(types);
    if (next.has(k)) next.delete(k); else next.add(k);
    setTypes(next);
    setSaved(false);
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{card.title}</span>
            {card.aryeoType && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{card.aryeoType === "ADDON" ? "Aryeo: add-on" : card.aryeoType === "LEGACY" ? "retired — still on orders" : "Aryeo: main"}</span>}
            {card.priceRange && <span className="text-[11px] text-muted-2">{card.priceRange}</span>}
            {card.orders > 0 && <span className="text-[11px] text-muted-2">{card.orders} order{card.orders === 1 ? "" : "s"}</span>}
            {saved && <span className="inline-flex items-center gap-1 rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-medium text-success"><Check className="size-2.5" /> mapped</span>}
          </div>
          {card.description && (
            <button onClick={() => setShowDesc((v) => !v)} className="mt-0.5 text-left text-xs text-muted hover:text-foreground">
              {showDesc ? card.description : `${card.description.slice(0, 140)}${card.description.length > 140 ? "… (tap for more)" : ""}`}
            </button>
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
        {hasVideo && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Video tier
            <select value={tier} onChange={(e) => { setTier(e.target.value); setSaved(false); }}
              className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand">
              <option value="standard">Standard</option>
              <option value="premium">Premium</option>
              <option value="personal_branding">Personal branding</option>
            </select>
          </label>
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
            const r = await saveProductMapping(card.id, { types: [...types], addonTypes: [...addons].filter((t) => types.has(t)), videoTier: hasVideo ? tier : null });
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
