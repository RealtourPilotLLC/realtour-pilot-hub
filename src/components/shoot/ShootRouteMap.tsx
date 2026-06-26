"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import type { Map as LMap } from "leaflet";
import type { ShootMapPin } from "@/lib/shoot";

// A small embedded Leaflet map: the day's shoots as numbered pins (this one in
// brand orange), the home base, and the driving route through them. Raw Leaflet
// via dynamic import (no SSR); divIcons so there are no missing marker images.
export function ShootRouteMap({
  pins, home, route,
}: {
  pins: ShootMapPin[];
  home: { lat: number; lng: number } | null;
  route: [number, number][];
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LMap | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled || !el.current || mapRef.current) return;
      const L = (await import("leaflet")).default;
      const map = L.map(el.current, { zoomControl: false, scrollWheelZoom: false, attributionControl: false });
      mapRef.current = map;
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(map);

      const bounds: [number, number][] = [];

      if (route.length > 1) {
        L.polyline(route, { color: "#e96320", weight: 3, opacity: 0.85 }).addTo(map);
        for (const p of route) bounds.push(p);
      }

      if (home) {
        L.marker([home.lat, home.lng], {
          icon: L.divIcon({
            className: "",
            html: `<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:9999px;background:#e96320;color:#fff;font-size:12px;box-shadow:0 0 0 2px rgba(255,255,255,.85)">⌂</span>`,
            iconSize: [22, 22], iconAnchor: [11, 11],
          }),
        }).addTo(map).bindTooltip("Home base", { direction: "top" });
        bounds.push([home.lat, home.lng]);
      }

      pins.forEach((p, i) => {
        const size = p.current ? 28 : 24;
        const bg = p.current ? "#e96320" : "#6ba3d6";
        const ring = p.current ? 3 : 2;
        L.marker([p.lat, p.lng], {
          icon: L.divIcon({
            className: "",
            html: `<span style="display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:9999px;background:${bg};color:#fff;font-weight:700;font-size:12px;box-shadow:0 0 0 ${ring}px rgba(255,255,255,.85),0 1px 4px rgba(0,0,0,.6)">${i + 1}</span>`,
            iconSize: [size, size], iconAnchor: [size / 2, size / 2],
          }),
        }).addTo(map).bindTooltip(`${p.time ? p.time + " · " : ""}${p.label}`, { direction: "top" });
        bounds.push([p.lat, p.lng]);
      });

      if (bounds.length > 1) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 14 });
      else if (bounds.length === 1) map.setView(bounds[0], 14);
    })();
    return () => {
      cancelled = true;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, [pins, home, route]);

  return <div ref={el} className="h-56 w-full" />;
}
