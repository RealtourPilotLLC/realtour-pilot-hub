"use client";

import { etDateTime, etTime } from "@/lib/datetime";
import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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
type AddressChoice = { lat: number; lng: number; label: string };
type AddressResult = Awaited<ReturnType<typeof distanceToAddress>>;
type ReadState<T> = { scope: string; pending: boolean; value: T | null; message: string | null };
const pinScope = (pin: MapPin | null) => pin ? JSON.stringify([pin.id, pin.projectId, pin.lat, pin.lng, pin.shootISO]) : "no-pin";
const addressScope = (scope: string, query: string) => JSON.stringify([scope, query]);
const mapAction = "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-1.5 rounded-lg border border-border-strong px-3 py-2 text-sm font-medium whitespace-normal hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";

// ET, date and time as two calls (see datetime.ts).
const fmt = (iso: string | null): string => (iso ? etDateTime(iso) : "—");
const fmtTimeOnly = (iso: string | null): string => (iso ? etTime(iso) : "");

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
  const selectedRef = useRef(selected);

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
  function drawMarkers() {
    const L = LRef.current;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!L || !map || !layer) return;
    layer.clearLayers();

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
      m.on("click", () => selectPin(p));
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
    selectPin(p);
    const map = mapRef.current;
    if (map && p.lat && p.lng) map.setView([p.lat, p.lng], 15, { animate: true });
  }
  function selectPin(p: MapPin) {
    if (pinScope(selectedRef.current) !== pinScope(p)) setTempPin(null);
    selectedRef.current = p;
    setSelected(p);
  }

  useEffect(() => {
    const next = selectedRef.current ? visible.find((p) => p.id === selectedRef.current?.id) ?? null : null;
    if (pinScope(next) !== pinScope(selectedRef.current)) setTempPin(null);
    selectedRef.current = next;
    setSelected(next);
  }, [visible]);

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

  return (
    <div className="space-y-3">
      {/* Day selector */}
      {dayMode && (
        <div className="flex flex-wrap gap-1.5 pb-1">
          {days!.map((d) => (
            <button
              key={d.key}
              onClick={() => setDay(d.key)}
              className={cn(
                `${mapAction} transition-colors`,
                day === d.key
                  ? "border-brand/30 bg-brand-soft text-brand"
                  : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
              )}
            >
              {d.label}
              <span className={cn("rounded-full px-1.5 text-ui-status", day === d.key ? "bg-brand/15" : "bg-surface-2")}>{d.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div ref={mapEl} className="h-[420px] w-full overflow-hidden rounded-2xl border border-border lg:h-[640px]" />
        <div className="space-y-3">
          {selected ? (
            <PinDetail pin={selected} home={home ?? null} onAddress={(address) => { if (pinScope(selectedRef.current) === pinScope(selected)) setTempPin(address); }} territories={territories} />
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
            {visible.length === 0 && <div className="px-2 py-3 text-ui-secondary text-muted">No shoots this day.</div>}
            {visible.map((p, i) => (
              <button
                key={p.id}
                onClick={() => focus(p)}
                className={cn(
                  "flex min-h-11 w-full flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
                  selected?.id === p.id && "bg-surface-2",
                )}
              >
                {dayMode && (
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ backgroundColor: p.color }}>{i + 1}</span>
                )}
                {!dayMode && <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />}
                <span className="min-w-0 flex-1 break-words">{p.title}</span>
                <span className="shrink-0 text-muted-2">{fmtTimeOnly(p.shootISO)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

type PinDetailProps = { pin: MapPin; home: Home; onAddress: (p: TempPin) => void; territories: Territory[] };
function PinDetail(props: PinDetailProps) {
  // A different shoot/coordinate/time is a different read context. Replacing
  // only this private panel clears its previous queries and cancels old reads.
  return <PinReadPanel key={pinScope(props.pin)} {...props} />;
}
function PinReadPanel({ pin, home, onAddress, territories }: PinDetailProps) {
  const scope = pinScope(pin);
  const homeScope = JSON.stringify([scope, home?.lat, home?.lng]);
  const scopeRef = useRef(scope), homeScopeRef = useRef(homeScope);
  const weatherReq = useRef(0), driveReq = useRef(0), addressReq = useRef(0);
  const [weatherState, setWeatherState] = useState<ReadState<Weather>>(() => ({ scope, pending: true, value: null, message: null }));
  const [driveState, setDriveState] = useState<ReadState<DriveInfo> | null>(null);
  const [addr, setAddr] = useState("");
  const addrRef = useRef(addr);
  const [addressState, setAddressState] = useState<ReadState<AddressResult> | null>(null);
  const addressPending = useRef<{ scope: string; req: number } | null>(null);
  const homePending = useRef<{ scope: string; req: number } | null>(null);
  const weather = weatherState?.scope === scope ? weatherState.value : null;
  const loadingW = weatherState?.scope === scope && weatherState.pending;
  const weatherMessage = weatherState?.scope === scope ? weatherState.message : null;
  const drive = driveState?.scope === homeScope ? driveState.value : null;
  const loadingD = driveState?.scope === homeScope && driveState.pending;
  const driveMessage = driveState?.scope === homeScope ? driveState.message : null;
  const currentAddressScope = addressScope(scope, addr);
  const addrRes = addressState?.scope === currentAddressScope ? addressState.value : null;
  const loadingA = addressState?.scope === currentAddressScope && addressState.pending;
  const addressMessage = addressState?.scope === currentAddressScope ? addressState.message : null;

  // Which real service territory(ies) does the looked-up address fall in, and
  // does the assigned shooter cover any of them?
  const territory = (() => {
    if (addrRes?.lat == null || addrRes?.lng == null) return null;
    const containing = territoriesContaining(addrRes.lat, addrRes.lng, territories);
    const mine = containing.filter((t) => covers(t, pin.photographer));
    return { containing, mine, inService: containing.length > 0, covered: mine.length > 0 };
  })();

  // Address typeahead state.
  const [sugs, setSugs] = useState<AddressChoice[]>([]);
  const sugsRef = useRef<AddressChoice[]>([]);
  const [showSugs, setShowSugs] = useState(false);
  const showRef = useRef(false);
  const [activeSug, setActiveSug] = useState(-1);
  const activeSugRef = useRef(-1);
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const [suggestionMessage, setSuggestionMessage] = useState<string | null>(null);
  const sugReqRef = useRef(0); // guards against out-of-order responses
  const skipSugRef = useRef<string | null>(null); // skip only the picked label
  const addressId = useId(), listId = `${addressId}-choices`, hintId = `${addressId}-hint`;
  const openSuggestions = (open: boolean) => { showRef.current = open; setShowSugs(open); };
  const activateSuggestion = (index: number) => { activeSugRef.current = index; setActiveSug(index); };
  // The suggestions list is rendered in a portal at the document root, anchored
  // under the input — so a parent card's `overflow-hidden` (e.g. the project
  // page's Location Section) can't clip it the way an absolute child would.
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
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
    if (!showSugs || activeSug < 0) return;
    const list = listRef.current;
    const option = list?.children.item(activeSug) as HTMLElement | null;
    if (!list || !option) return;
    const top = list.getBoundingClientRect().top + list.clientTop;
    const bottom = top + list.clientHeight;
    const rect = option.getBoundingClientRect();
    // Move this list's scroll position only. Long wrapped labels and keyboard
    // choices stay visible without scrolling the page or animating movement.
    if (rect.top < top || rect.height > list.clientHeight) list.scrollTop += rect.top - top;
    else if (rect.bottom > bottom) list.scrollTop += rect.bottom - bottom;
  }, [activeSug, showSugs, sugs]);

  const cancelReads = useCallback(() => {
    weatherReq.current++; driveReq.current++; addressReq.current++; sugReqRef.current++;
  }, []);
  useEffect(() => {
    const req = ++weatherReq.current;
    void (async () => {
      let value: Weather | null = null, message: string | null = null;
      try { value = await projectWeather(pin.projectId); if (!value) message = "Weather is unavailable for this shoot."; }
      catch { message = "Weather could not be loaded for this shoot."; }
      if (weatherReq.current === req && scopeRef.current === scope) setWeatherState({ scope, pending: false, value, message });
    })();
    return cancelReads;
  }, [scope, pin.projectId, cancelReads]);
  useEffect(() => { homeScopeRef.current = homeScope; driveReq.current++; }, [homeScope]);

  // Debounced suggestions as the user types.
  useEffect(() => {
    const reqId = ++sugReqRef.current;
    const pickedLabel = skipSugRef.current;
    skipSugRef.current = null;
    if (pickedLabel === addr) return;
    if (!focused) return;
    const q = addr.trim();
    if (q.length < 3) return;
    const t = setTimeout(async () => {
      let res: AddressChoice[] = [], message: string | null = null;
      try { res = await addressSuggestions(q); if (!res.length) message = "No address suggestions were returned. Enter the full address and calculate its distance."; }
      catch { message = "Address suggestions could not be loaded. You can enter the full address and calculate its distance."; }
      if (reqId === sugReqRef.current && scopeRef.current === scope && addrRef.current.trim() === q && focusedRef.current) {
        sugsRef.current = res; setSugs(res); activeSugRef.current = -1; setActiveSug(-1);
        showRef.current = res.length > 0; setShowSugs(res.length > 0); setSuggestionMessage(message);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [addr, scope, focused]);

  // Pick a suggestion: fill the field and route straight to its coordinates
  // (no second geocode needed).
  function pickSuggestion(s: AddressChoice) {
    if (scopeRef.current !== scope || !showRef.current || !sugsRef.current.some((choice) => choice.lat === s.lat && choice.lng === s.lng && choice.label === s.label)) return;
    sugReqRef.current++;
    skipSugRef.current = s.label;
    addrRef.current = s.label; setAddr(s.label); setSuggestionMessage(null);
    sugsRef.current = []; setSugs([]); openSuggestions(false); activateSuggestion(-1);
    onAddress({ lat: s.lat, lng: s.lng, label: s.label }); // drop temp pin
    const req = ++addressReq.current, requestScope = addressScope(scope, s.label);
    addressPending.current = { scope: requestScope, req };
    setAddressState({ scope: requestScope, pending: true, value: null, message: null });
    void (async () => {
      let value: AddressResult | null = null, message: string | null = null;
      try {
        const d = await driveInfo(pin.lat, pin.lng, s.lat, s.lng);
        value = d ? { ok: true, label: s.label, lat: s.lat, lng: s.lng, drive: d, message: "ok" } : { ok: false, label: s.label, lat: s.lat, lng: s.lng, message: "Couldn't compute a route." };
      } catch { message = "Distance could not be loaded for this address. Your chosen address is kept."; }
      if (addressReq.current === req && scopeRef.current === scope && addrRef.current === s.label) {
        addressPending.current = null;
        setAddressState({ scope: requestScope, pending: false, value, message });
      }
    })();
  }
  function calculateAddress() {
    const query = addrRef.current, requestScope = addressScope(scope, query);
    if (!query.trim() || scopeRef.current !== scope || addressPending.current?.scope === requestScope && addressPending.current.req === addressReq.current) return;
    openSuggestions(false); activateSuggestion(-1); sugReqRef.current++;
    const req = ++addressReq.current;
    addressPending.current = { scope: requestScope, req };
    setAddressState({ scope: requestScope, pending: true, value: null, message: null }); onAddress(null);
    void (async () => {
      let value: AddressResult | null = null, message: string | null = null;
      try { value = await distanceToAddress(pin.lat, pin.lng, query); }
      catch { message = "Distance could not be loaded. Your address is still here; try again."; }
      if (addressReq.current === req && scopeRef.current === scope && addrRef.current === query) {
        addressPending.current = null;
        setAddressState({ scope: requestScope, pending: false, value, message });
        if (value?.ok && value.lat != null && value.lng != null) onAddress({ lat: value.lat, lng: value.lng, label: value.label ?? query });
      }
    })();
  }
  function calculateHome() {
    if (!home || scopeRef.current !== scope || homeScopeRef.current !== homeScope || homePending.current?.scope === homeScope && homePending.current.req === driveReq.current) return;
    const req = ++driveReq.current;
    homePending.current = { scope: homeScope, req };
    setDriveState({ scope: homeScope, pending: true, value: null, message: null });
    void (async () => {
      let value: DriveInfo | null = null, message: string | null = null;
      try { value = await driveInfo(pin.lat, pin.lng, home.lat, home.lng); if (!value) message = "The drive to home base is unavailable."; }
      catch { message = "The drive to home base could not be loaded. Try again."; }
      if (driveReq.current === req && homeScopeRef.current === homeScope && scopeRef.current === scope) { homePending.current = null; setDriveState({ scope: homeScope, pending: false, value, message }); }
    })();
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <Link href={`/projects/${pin.projectId}`} className="inline-flex min-h-11 items-center rounded-lg break-words text-ui-body font-semibold leading-snug hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">{pin.title}</Link>
          <CopyButton value={pin.title} title="Copy address" className="mt-0.5 shrink-0" />
        </div>
        <span className="max-w-full rounded-full px-2 py-0.5 text-ui-status font-medium" style={{ color: ink(pin.color), backgroundColor: pin.color + "22" }}>{pin.stage}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-ui-secondary text-muted">
        <span className="break-words">{pin.client}</span>
        {pin.hasDrone && <DroneBadge size="xs" />}
      </div>

      <dl className="mt-3 space-y-1.5 text-sm">
        <Row icon={<Clock className="size-3.5" />} label="Shoot">{fmt(pin.shootISO)}{pin.endISO ? ` – ${fmtTimeOnly(pin.endISO)}` : ""}</Row>
        <Row icon={<Camera className="size-3.5" />} label="Shooter">{pin.photographer ?? "Unassigned"}</Row>
        <Row icon={<CloudSun className="size-3.5" />} label="Weather">
          {loadingW ? <span role="status" className="inline-flex items-center gap-1"><Loader2 className="size-3.5 animate-spin" />Loading weather…</span> : weather ? `${weather.emoji} ${weather.tempF}° · ${weather.label}` : <span role="status" className="text-muted-2">{weatherMessage ?? "Weather not loaded."}</span>}
        </Row>
      </dl>

      {home && (
        <button
          disabled={loadingD}
          onClick={calculateHome}
          className={`${mapAction} mt-3`}
        >
          {loadingD ? <Loader2 className="size-3.5 animate-spin" /> : <Home className="size-3.5" />} Drive to home base
        </button>
      )}
      {drive && <DriveLine drive={drive} />}
      {driveMessage && <p role="alert" className="mt-2 text-ui-status leading-relaxed text-danger">{driveMessage}</p>}

      <div className="mt-3 border-t border-border pt-3">
        <label htmlFor={addressId} className="mb-1 flex items-center gap-1.5 text-ui-secondary font-semibold text-muted">
          <Ruler className="size-3.5" /> Distance to an address
        </label>
        <div className="flex flex-wrap gap-1.5">
          <div ref={boxRef} className="relative min-w-0 flex-1">
            <input
              id={addressId}
              value={addr}
              onChange={(e) => {
                addrRef.current = e.target.value; setAddr(e.target.value); addressReq.current++; sugReqRef.current++;
                setAddressState(null); onAddress(null); sugsRef.current = []; setSugs([]); openSuggestions(false); activateSuggestion(-1); setSuggestionMessage(null);
              }}
              onFocus={() => { focusedRef.current = true; setFocused(true); if (sugsRef.current.length) openSuggestions(true); }}
              onBlur={() => { focusedRef.current = false; setFocused(false); sugReqRef.current++; openSuggestions(false); activateSuggestion(-1); }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                const choices = sugsRef.current;
                if ((e.key === "ArrowDown" || e.key === "ArrowUp") && choices.length) {
                  e.preventDefault(); openSuggestions(true);
                  activateSuggestion(e.key === "ArrowDown" ? Math.min(activeSugRef.current + 1, choices.length - 1) : activeSugRef.current < 0 ? choices.length - 1 : Math.max(activeSugRef.current - 1, 0));
                } else if (e.key === "Escape") { e.preventDefault(); sugReqRef.current++; openSuggestions(false); activateSuggestion(-1); }
                else if (e.key === "Enter") { e.preventDefault(); const chosen = showRef.current ? choices[activeSugRef.current] : null; if (chosen) pickSuggestion(chosen); else calculateAddress(); }
              }}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showSugs && sugs.length > 0 && !!menu}
              aria-controls={showSugs && sugs.length > 0 && menu ? listId : undefined}
              aria-activedescendant={showSugs && menu && activeSug >= 0 ? `${listId}-${activeSug}` : undefined}
              aria-describedby={hintId}
              placeholder="Start typing an address…"
              autoComplete="off"
              className="min-h-11 w-full rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            />
            {showSugs && sugs.length > 0 && menu &&
              createPortal(
                <ul
                  ref={listRef}
                  id={listId} role="listbox" aria-label="Address suggestions"
                  style={{ position: "fixed", left: menu.left, top: menu.top, width: menu.width, zIndex: 2000 }}
                  className="max-h-56 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg"
                >
                  {sugs.map((s, i) => (
                    <li key={i} id={`${listId}-${i}`} role="option" aria-selected={activeSug === i}>
                      <button
                        type="button"
                        tabIndex={-1}
                        onPointerDown={(e) => e.preventDefault()}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pickSuggestion(s)}
                        className={cn("block min-h-11 w-full break-words rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand", activeSug === i && "bg-surface-2")}
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
            onClick={calculateAddress}
            className="inline-flex min-h-11 min-w-11 max-w-full shrink-0 items-center justify-center gap-1.5 rounded-lg bg-brand-action px-3 py-2 text-sm font-medium text-brand-fg whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
          >
            {loadingA ? <Loader2 className="size-3.5 animate-spin" /> : <Navigation className="size-3.5" />}
            Calculate distance
          </button>
        </div>
        <p id={hintId} className="mt-1 text-ui-status leading-relaxed text-muted">Use the arrow keys to choose a suggestion, then Enter. Enter also calculates a typed address; Escape closes suggestions.</p>
        {suggestionMessage && <p role="status" className="mt-2 text-ui-status leading-relaxed text-muted">{suggestionMessage}</p>}
        {addressMessage && <p role="alert" className="mt-2 text-ui-status leading-relaxed text-danger">{addressMessage}</p>}
        {loadingA && <p role="status" className="mt-2 text-ui-status text-muted">Calculating the distance to the submitted address…</p>}
        {addrRes && (
          addrRes.drive ? (
            <div className="mt-2">
              {addrRes.label && <div className="mb-1 break-words text-ui-status text-muted-2">{addrRes.label}</div>}
              <DriveLine drive={addrRes.drive} />
              {territory && (
                <div
                  className={cn(
                    "mt-1.5 flex items-start gap-1.5 rounded-lg px-3 py-2 text-ui-status font-medium leading-relaxed",
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
            <div role="alert" className="mt-2 text-ui-status leading-relaxed text-danger">{addrRes.message}</div>
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
      <div className="mb-2 flex items-center gap-1.5 text-ui-secondary font-semibold text-muted">
        <MapPin className="size-3.5" /> Service territories
      </div>
      <ul className="space-y-2">
        {territories.map((t) => (
          <li key={t.uuid} className="flex items-start gap-2">
            <span className="mt-0.5 size-3 shrink-0 rounded-sm" style={{ backgroundColor: t.color, boxShadow: `0 0 0 1px ${t.color}` }} />
            <div className="min-w-0">
              <div className="break-words text-ui-secondary font-medium leading-relaxed">{t.name}</div>
              <div className="break-words text-ui-status text-muted-2">{t.members.join(", ") || "Unassigned"}</div>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-ui-status leading-relaxed text-muted-2">Synced from Aryeo. Tap a shoot to highlight its shooter&rsquo;s area.</p>
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="flex w-20 shrink-0 items-center gap-1.5 text-ui-secondary text-muted-2">{icon}{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}
