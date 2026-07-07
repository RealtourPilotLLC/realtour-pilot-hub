"use server";

import { requireAdmin } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { droneAirspace, type DroneAirspace } from "@/lib/faa";
import { OpenPhone, defaultOpenPhoneNumber, phoneKey } from "@/lib/integrations/openphone";

export type AirspaceResult = {
  airspace: DroneAirspace | null;
  photographer: { id: string; name: string; firstName: string; hasPhone: boolean } | null;
  draft: string | null;
};

function et(d: Date | null): string {
  if (!d) return "the shoot date";
  return d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Airspace check for a project + a ready-to-send advisory draft for the creative.
export async function projectAirspace(projectId: string): Promise<AirspaceResult> {
  await requireAdmin();
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true, lat: true, lng: true, shootDate: true,
      photographer: { select: { id: true, name: true, phone: true } },
    },
  });
  if (!p?.lat || !p?.lng) return { airspace: null, photographer: null, draft: null };

  const airspace = await droneAirspace(p.lat, p.lng);
  const ph = p.photographer;
  const photographer = ph
    ? { id: ph.id, name: ph.name, firstName: ph.name.split(" ")[0], hasPhone: !!ph.phone }
    : null;

  let draft: string | null = null;
  if (airspace.warning) {
    const who = photographer ? `${photographer.firstName}, ` : "";
    const head =
      airspace.status === "restricted"
        ? `${who}heads up on the drone shoot at ${p.title} (${et(p.shootDate)}): it's in controlled airspace (Class ${airspace.airspaceClass ?? "?"}) near ${airspace.airport ?? "an airport"} with a 0 ft LAANC ceiling — manual FAA authorization is required, so we likely can't fly the drone there. Let's confirm before you go.`
        : `${who}heads up on the drone shoot at ${p.title} (${et(p.shootDate)}): it's in controlled airspace (Class ${airspace.airspaceClass ?? "?"}) near ${airspace.airport ?? "an airport"}. Please file a LAANC authorization (auto-approved up to ${airspace.ceiling} ft) before the shoot.`;
    draft = head;
  }

  return { airspace, photographer, draft };
}

// Send the drone advisory to the assigned creative via OpenPhone (human clicks Send).
export async function sendDroneAdvisory(
  projectId: string,
  body: string,
): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const text = body.trim();
  if (!text) return { ok: false, message: "Nothing to send." };
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { title: true, photographer: { select: { name: true, phone: true } } },
  });
  const ph = p?.photographer;
  if (!ph?.phone) return { ok: false, message: "No phone on file for the assigned creative." };
  const k = phoneKey(ph.phone);
  if (k.length !== 10) return { ok: false, message: "Creative's phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  try {
    await OpenPhone.sendMessage(from, `+1${k}`, text);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send text." };
  }
  await prisma.project.update({
    where: { id: projectId },
    data: { activities: { create: { type: "SYSTEM", body: `Drone airspace advisory texted to ${ph.name}.` } } },
  });
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, message: `Advisory sent to ${ph.name.split(" ")[0]}.` };
}
