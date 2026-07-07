"use server";

import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guards";
import { weatherAt, driveBetween, geocodeAddress, suggestAddresses, type Weather, type DriveInfo } from "@/lib/travel";

// Admin gate for every action here (same audience as the /map page) — otherwise
// these are a free geocoding/routing proxy burning the providers' rate limits
// that payroll mileage depends on. They're read-only lookups, so the owner's
// read-only "view as" preview may still call them (the map keeps rendering).
const requireMapAccess = () => requireRole(["OWNER", "ADMIN"], { allowImpersonation: true });

// Weather for a project's shoot (lat/lng + shoot time).
export async function projectWeather(projectId: string): Promise<Weather | null> {
  await requireMapAccess();
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { lat: true, lng: true, shootDate: true },
  });
  if (!p?.lat || !p?.lng) return null;
  const when = p.shootDate ?? new Date();
  return weatherAt(p.lat, p.lng, when.toISOString());
}

// Drive distance/time/cost between two coordinates.
export async function driveInfo(
  aLat: number, aLng: number, bLat: number, bLng: number,
): Promise<DriveInfo | null> {
  await requireMapAccess();
  return driveBetween(aLat, aLng, bLat, bLng);
}

// Address autocomplete for the distance tool (US-only, up to 5 candidates).
export async function addressSuggestions(
  query: string,
): Promise<{ lat: number; lng: number; label: string }[]> {
  await requireMapAccess();
  return suggestAddresses(query, 5);
}

// "Distance from this pin to another address" — geocode the address, then route.
export async function distanceToAddress(
  fromLat: number, fromLng: number, address: string,
): Promise<{ ok: boolean; message: string; label?: string; lat?: number; lng?: number; drive?: DriveInfo }> {
  await requireMapAccess();
  const geo = await geocodeAddress(address);
  if (!geo) return { ok: false, message: "Couldn't find that address." };
  const drive = await driveBetween(fromLat, fromLng, geo.lat, geo.lng);
  if (!drive) return { ok: false, message: "Couldn't compute a route." };
  return { ok: true, message: "ok", label: geo.label, lat: geo.lat, lng: geo.lng, drive };
}
