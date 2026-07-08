"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  Clock, Camera, CloudSun, Car, MapPin, Loader2, Home, Navigation, DollarSign, Ruler,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { projectWeather, driveInfo, distanceToAddress, addressSuggestions } from "@/app/map/actions";
import { DroneBadge } from "@/components/project/DroneBadge";
import { DroneAdvisory } from "@/components/project/DroneAdvisory";
import type { Weather, DriveInfo } from "@/lib/travel";
import { getTerritories, territoriesContaining, covers, type Territory } from "@/lib/territories";
import { CopyButton } from "@/components/ui/CopyButton";
import { ink } from "@/components/ui/Badge";

export type MapPin = {
  id: string; // appointment id (or project id in single-pin mode)
  projectId: string;
  title: string;
  lat: number;
  lng: number;
  color: string;
  stage: string;
  client: string;
  shootISO: string | null;
  endISO: string | null;
  photographer: string | null;
  homeLat?: number | null; // assigned photographer's home base (territory center)
  homeLng?: number | null;
  radiusMi?: number | null; // their service radius
  dayKey?: string;
  hasDrone?: boolean;
};

export type MapDay = { key: string; label: string; count: number };
type Home = { lat: number; lng: number; label: string } | null;
type TempPin = { lat: number; lng: number; label: string } | null;

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}
function fmtTimeOnly(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
}

export function ProjectMap({
  pins, days, defaultDay, home,
}: {
  pins: MapPin[];
  days?: MapDay[];
  defaultDay?: string;
  home?: Home;
}) {
  const dayMode = !!days && days.length > 0;
  const [day, setDay] = useState<string>(defaultDay ?? days?.[0]?.key ?? "");
  // On a single-pin map (e.g. a project's Location section), pre-select the pin
  // so the detail panel + "Distance to an address" box show without a tap.
  const [selected, setSelected] = useState<MapPin | null>(() =>
    !dayMode && pins.length === 1 ? pins[0] : null,
  );
  const [tempPin, setTempPin] = useState<TempPin>(null); // address from the distance tool

  // Real service-territory polygons synced from Aryeo.
  const territories = useMemo(() => getTerritories(), []);

  const mapEl = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const LRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layerRef = useRef<any>(null);
  // Separate overlay for the temp address pin, so toggling it doesn't force a
  // full marker redraw / bounds reset.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const overlayRef = useRef<any>(null);
  // Persistent layer for the service-territory polygons (under markers).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const terrLayerRef = useRef<any>(null);

  // Pins shown right now: the chosen day (ordered by time) or everything.
  const visible = useMemo(() => {
    const list = dayMode ? pins.filter((p) => p.dayKey === day) : pins;
    return [...list].sort((a, b) => (a.shootISO ?? "").localeCompare(b.shootISO ?? ""));
  }, [pins, day, dayMode]);

  // Init the map once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !mapEl.current || mapRef.current) return;
      LRef.current = L;
      const map = L.map(mapEl.current, { zoomControl: true, scrollWheelZoom: true });
      mapRef.current = map;
      // Satellite imagery (Esri — free, no key) + light labels for streets/towns.
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Tiles &copy; Esri", maxZoom: 19,
      }).addTo(map);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 19,
      }).addTo(map);
      // Territories first so they sit beneath the route line + markers.
      terrLayerRef.current = L.layerGroup().addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      overlayRef.current = L.layerGroup().addTo(map);
      map.setView([40.0, -75.4], 9);
      drawTerritories();
      drawMarkers();
      drawOverlay();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw markers + route whenever the visible set changes.
  useEffect(() => {
    drawMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Re-highlight the selected shooter's territory + redraw the temp address pin
  // when selection / address change.
  useEffect(() => {
    drawTerritories();
    drawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, tempPin]);

  // Clear the temp address pin when the selected shoot changes.
  useEffect(() => {
    setTempPin(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  function drawMarkers() {
    const L = LRef.current;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!L || !map || !layer) return;
    layer.clearLayers();
    setSelected((s) => (s && visible.some((p) => p.id === s.id) ? s : null));

    const pts = visible.filter((p) => p.lat && p.lng);

    // Fan out pins that share the exact same spot so none hide behind another.
    const groups = new Map<string, MapPin[]>();
    for (const p of pts) {
      const k = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
    }
    const offsetOf = (p: MapPin): [number, number] => {
      const k = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
      const g = groups.get(k)!;
      if (g.length < 2) return [p.lat, p.lng];
      const j = g.indexOf(p);
      const r = 0.00045; // ~50m
      const ang = (2 * Math.PI * j) / g.length;
      return [p.lat + r * Math.cos(ang), p.lng + (r * Math.sin(ang)) / Math.cos((p.lat * Math.PI) / 180)];
    };

    pts.forEach((p, i) => {
      const label = dayMode ? `<span style="color:#fff;font-size:10px;font-weight:700;line-height:18px">${i + 1}</span>` : "";
      const icon = L.divIcon({
        className: "",
        html: `<span style="display:flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:9999px;background:${p.color};box-shadow:0 0 0 2px rgba(255,255,255,.9),0 1px 4px rgba(0,0,0,.6)">${label}</span>`,
        iconSize: [18, 18], iconAnchor: [9, 9],
      });
      const m = L.marker(offsetOf(p), { icon, title: p.title }).addTo(layer);
      m.on("click", () => setSelected(p));
    });

    // Route line connecting the day's shoots in time order.
    if (dayMode && pts.length > 1) {
      L.polyline(pts.map((p) => offsetOf(p)), {
        color: "#e96320", weight: 2, opacity: 0.7, dashArray: "4 6",
      }).addTo(layer);
    }
    if (home) {
      const hIcon = L.divIcon({
        className: "",
        html: `<span style="display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:9999px;background:#e96320;color:#fff;font-size:12px;box-shadow:0 0 0 2px rgba(255,255,255,.9)">⌂</span>`,
        iconSize: [20, 20], iconAnchor: [10, 10],
      });
      L.marker([home.lat, home.lng], { icon: hIcon, title: "Home base" }).addTo(layer);
    }

    const bounds = [...pts.map((p) => [p.lat, p.lng] as [number, number])];
    if (home) bounds.push([home.lat, home.lng]);
    if (bounds.length) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
  }

  // The real Aryeo service-territory polygons. Always drawn faint for context;
  // the selected shoot's photographer's territory(ies) are highlighted.
  function drawTerritories() {
    const L = LRef.current;
    const map = mapRef.current;
    const layer = terrLayerRef.current;
    if (!L || !map || !layer) return;
    layer.clearLayers();

    const photog = selected?.photographer ?? null;
    for (const t of territories) {
      const mine = covers(t, photog);
      L.polygon(t.rings, {
        color: t.color,
        weight: mine ? 2.5 : 1,
        opacity: mine ? 0.95 : 0.4,
        fillColor: t.color,
        fillOpacity: mine ? 0.14 : 0.04,
        dashArray: mine ? undefined : "4 5",
        interactive: false,
      }).addTo(layer);
    }
  }

  // Temp pin for the looked-up address. Red when it falls outside every service
  // territory, orange when it's inside our coverage.
  function drawOverlay() {
    const L = LRef.current;
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!L || !map || !overlay) return;
    overlay.clearLayers();
    if (!tempPin) return;

    const outsideService = territoriesContaining(tempPin.lat, tempPin.lng, territories).length === 0;
    const pinColor = outsideService ? "#f87171" : "#e96320";
    const tIcon = L.divIcon({
      className: "",
      html: `<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:9999px 9999px 9999px 0;transform:rotate(45deg);background:${pinColor};box-shadow:0 0 0 2px rgba(255,255,255,.9),0 1px 5px rgba(0,0,0,.6)"><span style="transform:rotate(-45deg);color:#fff;font-size:11px">★</span></span>`,
      iconSize: [22, 22], iconAnchor: [11, 20],
    });
    L.marker([tempPin.lat, tempPin.lng], { icon: tIcon, title: tempPin.label }).addTo(overlay);

    // Frame the address + the selected shoot so the distance reads visually.
    const b: [number, number][] = [[tempPin.lat, tempPin.lng]];
    if (selected) b.push([selected.lat, selected.lng]);
    if (b.length > 1) map.fitBounds(b, { padding: [70, 70], maxZoom: 13 });
  }

  function focus(p: MapPin) {
    setSelected(p);
    const map = mapRef.current;
    if (map && p.lat && p.lng) map.setView([p.lat, p.lng], 15, { animate: true });
  }

  return (
    <div className="space-y-3">
      {/* Day selector */}
      {dayMode && (
        <div className="flex gap-1.5 overflow-x-auto scroll-thin pb-1">
          {days!.map((d) => (
            <button
              key={d.key}
              onClick={() => setDay(d.key)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                day === d.key
                  ? "border-brand/30 bg-brand-soft text-brand"
                  : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
              )}
            >
              {d.label}
              <span className={cn("rounded-full px-1.5 text-[10px]", day === d.key ? "bg-brand/15" : "bg-surface-2")}>{d.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div ref={mapEl} className="h-[420px] w-full overflow-hidden rounded-2xl border border-border lg:h-[640px]" />
        <div className="space-y-3">
          {selected ? (
            <PinDetail pin={selected} home={home ?? null} onAddress={setTempPin} territories={territories} />
          ) : (
            <div className="space-y-3">
              <div className="rounded-2xl border border-border bg-surface p-4 text-sm text-muted">
                <MapPin className="mb-1 size-4 text-brand" />
                {dayMode ? "Pins are numbered in shoot order. Tap one for details, weather & drive times." : "Tap the pin for details, weather & drive times."}
              </div>
              <TerritoryLegend territories={territories} />
            </div>
          )}
          <div className="max-h-[260px] space-y-1 overflow-y-auto rounded-2xl border border-border bg-surface p-2 lg:max-h-[300px]">
            {visible.length === 0 && <div className="px-2 py-3 text-xs text-muted">No shoots this day.</div>}
            {visible.map((p, i) => (
              <button
                key={p.id}
                onClick={() => focus(p)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-surface-2",
                  selected?.id === p.id && "bg-surface-2",
                )}
              >
                {dayMode && (
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ backgroundColor: p.color }}>{i + 1}</span>
                )}
                {!dayMode && <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />}
                <span className="min-w-0 flex-1 truncate">{p.title}</span>
                <span className="shrink-0 text-muted-2">{fmtTimeOnly(p.shootISO)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PinDetail({ pin, home, onAddress, territories }: { pin: MapPin; home: Home; onAddress: (p: TempPin) => void; territories: Territory[] }) {
  const [weather, setWeather] = useState<Weather | null>(null);
  const [loadingW, startW] = useTransition();
  const [drive, setDrive] = useState<DriveInfo | null>(null);
  const [loadingD, startD] = useTransition();

  const [addr, setAddr] = useState("");
  const [addrRes, setAddrRes] = useState<{ label?: string; lat?: number; lng?: number; drive?: DriveInfo; message: string } | null>(null);
  const [loadingA, startA] = useTransition();

  // Which real service territory(ies) does the looked-up address fall in, and
  // does the assigned shooter cover any of them?
  const territory = (() => {
    if (addrRes?.lat == null || addrRes?.lng == null) return null;
    const containing = territoriesContaining(addrRes.lat, addrRes.lng, territories);
    const mine = containing.filter((t) => covers(t, pin.photographer));
    return { containing, mine, inService: containing.length > 0, covered: mine.length > 0 };
  })();

  // Address typeahead state.
  const [sugs, setSugs] = useState<{ lat: number; lng: number; label: string }[]>([]);
  const [showSugs, setShowSugs] = useState(false);
  const sugReqRef = useRef(0); // guards against out-of-order responses
  const skipSugRef = useRef(false); // skip the fetch triggered by picking a result
  // The suggestions list is rendered in a portal at the document root, anchored
  // under the input — so a parent card's `overflow-hidden` (e.g. the project
  // page's Location Section) can't clip it the way an absolute child would.
  const boxRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ left: number; top: number; width: number } | null>(null);
  const placeMenu = () => {
    const r = boxRef.current?.getBoundingClientRect();
    if (r) setMenu({ left: r.left, top: r.bottom + 4, width: r.width });
  };
  useEffect(() => {
    if (!showSugs) return;
    placeMenu();
    const on = () => placeMenu();
    window.addEventListener("scroll", on, true);
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on, true);
      window.removeEventListener("resize", on);
    };
  }, [showSugs, sugs]);

  useEffect(() => {
    setWeather(null); setDrive(null); setAddrRes(null); setAddr("");
    setSugs([]); setShowSugs(false);
    startW(async () => setWeather(await projectWeather(pin.projectId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin.id]);

  // Debounced suggestions as the user types.
  useEffect(() => {
    if (skipSugRef.current) { skipSugRef.current = false; return; }
    const q = addr.trim();
    if (q.length < 3) { setSugs([]); setShowSugs(false); return; }
    const reqId = ++sugReqRef.current;
    const t = setTimeout(async () => {
      const res = await addressSuggestions(q);
      if (reqId === sugReqRef.current) { setSugs(res); setShowSugs(true); }
    }, 300);
    return () => clearTimeout(t);
  }, [addr]);

  // Pick a suggestion: fill the field and route straight to its coordinates
  // (no second geocode needed).
  function pickSuggestion(s: { lat: number; lng: number; label: string }) {
    skipSugRef.current = true;
    setAddr(s.label);
    setSugs([]); setShowSugs(false);
    onAddress({ lat: s.lat, lng: s.lng, label: s.label }); // drop temp pin
    startA(async () => {
      const d = await driveInfo(pin.lat, pin.lng, s.lat, s.lng);
      setAddrRes(d ? { label: s.label, lat: s.lat, lng: s.lng, drive: d, message: "ok" } : { lat: s.lat, lng: s.lng, message: "Couldn't compute a route." });
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <Link href={`/projects/${pin.projectId}`} className="font-semibold leading-snug hover:text-brand">{pin.title}</Link>
          <CopyButton value={pin.title} title="Copy address" className="mt-0.5 shrink-0" />
        </div>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color: ink(pin.color), backgroundColor: pin.color + "22" }}>{pin.stage}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
        <span className="truncate">{pin.client}</span>
        {pin.hasDrone && <DroneBadge size="xs" />}
      </div>

      <dl className="mt-3 space-y-1.5 text-sm">
        <Row icon={<Clock className="size-3.5" />} label="Shoot">{fmt(pin.shootISO)}{pin.endISO ? ` – ${fmtTimeOnly(pin.endISO)}` : ""}</Row>
        <Row icon={<Camera className="size-3.5" />} label="Shooter">{pin.photographer ?? "Unassigned"}</Row>
        <Row icon={<CloudSun className="size-3.5" />} label="Weather">
          {loadingW ? <Loader2 className="size-3.5 animate-spin" /> : weather ? `${weather.emoji} ${weather.tempF}° · ${weather.label}` : <span className="text-muted-2">—</span>}
        </Row>
      </dl>

      {home && (
        <button
          onClick={() => startD(async () => setDrive(await driveInfo(pin.lat, pin.lng, home.lat, home.lng)))}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2"
        >
          {loadingD ? <Loader2 className="size-3.5 animate-spin" /> : <Home className="size-3.5" />} Drive to home base
        </button>
      )}
      {drive && <DriveLine drive={drive} />}

      <div className="mt-3 border-t border-border pt-3">
        <label className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
          <Ruler className="size-3.5" /> Distance to an address
        </label>
        <div className="flex gap-1.5">
          <div ref={boxRef} className="relative min-w-0 flex-1">
            <input
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              onFocus={() => { if (sugs.length) setShowSugs(true); }}
              onBlur={() => setTimeout(() => setShowSugs(false), 150)}
              onKeyDown={(e) => { if (e.key === "Escape") setShowSugs(false); }}
              placeholder="Start typing an address…"
              autoComplete="off"
              className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm outline-none focus:border-brand"
            />
            {showSugs && sugs.length > 0 && menu &&
              createPortal(
                <ul
                  style={{ position: "fixed", left: menu.left, top: menu.top, width: menu.width, zIndex: 2000 }}
                  className="max-h-56 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg"
                >
                  {sugs.map((s, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s); }}
                        className="block w-full truncate px-2.5 py-1.5 text-left text-xs hover:bg-surface-2"
                        title={s.label}
                      >
                        {s.label}
                      </button>
                    </li>
                  ))}
                </ul>,
                document.body,
              )}
          </div>
          <button
            disabled={loadingA || !addr.trim()}
            onClick={() => startA(async () => {
              const r = await distanceToAddress(pin.lat, pin.lng, addr);
              setAddrRes(r);
              if (r.ok && r.lat != null && r.lng != null) onAddress({ lat: r.lat, lng: r.lng, label: r.label ?? addr });
            })}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {loadingA ? <Loader2 className="size-3.5 animate-spin" /> : <Navigation className="size-3.5" />}
          </button>
        </div>
        {addrRes && (
          addrRes.drive ? (
            <div className="mt-2">
              {addrRes.label && <div className="mb-1 truncate text-[11px] text-muted-2">{addrRes.label}</div>}
              <DriveLine drive={addrRes.drive} />
              {territory && (
                <div
                  className={cn(
                    "mt-1.5 flex items-start gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium",
                    territory.covered
                      ? "bg-success/10 text-success"
                      : territory.inService
                        ? "bg-warning/10 text-warning"
                        : "bg-danger/10 text-danger",
                  )}
                >
                  <MapPin className="mt-0.5 size-3 shrink-0" />
                  <span>
                    {territory.covered
                      ? `In ${pin.photographer ?? "the shooter"}'s territory — ${territory.mine.map((t) => t.name).join(", ")}`
                      : territory.inService
                        ? `In our service area (${territory.containing.map((t) => t.name).join(", ")}) — covered by ${[...new Set(territory.containing.flatMap((t) => t.members))].join(", ")}, not ${pin.photographer ?? "this shooter"}`
                        : "Outside all service territories"}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-2 text-xs text-danger">{addrRes.message}</div>
          )
        )}
      </div>

      {/* Drone airspace check + advisory (only for drone shoots) */}
      {pin.hasDrone && (
        <div className="mt-3">
          <DroneAdvisory projectId={pin.projectId} />
        </div>
      )}
    </div>
  );
}

function DriveLine({ drive }: { drive: DriveInfo }) {
  const h = Math.floor(drive.minutes / 60);
  const m = Math.round(drive.minutes % 60);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="inline-flex items-center gap-1 font-medium"><Car className="size-3.5 text-brand" /> {drive.miles.toFixed(1)} mi</span>
      <span className="inline-flex items-center gap-1 text-muted">{h > 0 ? `${h}h ` : ""}{m}m</span>
      <span className="inline-flex items-center gap-1 text-muted"><DollarSign className="size-3.5" />{drive.cost.toFixed(2)} <span className="text-muted-2">@ $0.65/mi</span></span>
    </div>
  );
}

// Coverage legend — the real Aryeo service territories + who covers each.
function TerritoryLegend({ territories }: { territories: Territory[] }) {
  if (territories.length === 0) return null;
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <MapPin className="size-3.5" /> Service territories
      </div>
      <ul className="space-y-2">
        {territories.map((t) => (
          <li key={t.uuid} className="flex items-start gap-2">
            <span className="mt-0.5 size-3 shrink-0 rounded-sm" style={{ backgroundColor: t.color, boxShadow: `0 0 0 1px ${t.color}` }} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium leading-tight">{t.name}</div>
              <div className="truncate text-[11px] text-muted-2">{t.members.join(", ") || "Unassigned"}</div>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[10px] leading-snug text-muted-2">Synced from Aryeo. Tap a shoot to highlight its shooter&rsquo;s area.</p>
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex w-16 shrink-0 items-center gap-1.5 text-xs text-muted-2">{icon}{label}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}
