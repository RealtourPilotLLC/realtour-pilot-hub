"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { OpenPhone, defaultOpenPhoneNumber, phoneKey } from "@/lib/integrations/openphone";

export type ActionResult = { ok: boolean; message: string };

// Text a teammate via OpenPhone. Human-initiated (Kyle/Jordan clicks Send) — the
// platform never auto-texts. Used for shoot coordination + morning well-wishes.
export async function sendTeamText(memberId: string, body: string): Promise<ActionResult> {
  const text = body.trim();
  if (!text) return { ok: false, message: "Write a message first." };
  const member = await prisma.teamMember.findUnique({
    where: { id: memberId },
    select: { phone: true, name: true },
  });
  if (!member?.phone) return { ok: false, message: "No phone number on file for this teammate." };
  const k = phoneKey(member.phone);
  if (k.length !== 10) return { ok: false, message: "Their phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  try {
    await OpenPhone.sendMessage(from, `+1${k}`, text);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send text." };
  }
  revalidatePath(`/team/${memberId}`);
  return { ok: true, message: `Text sent to ${member.name.split(" ")[0]}.` };
}

// Save a creative's pay settings (manually set; drive automatic payroll). The
// home address is geocoded to lat/lng for the mileage radius.
export async function savePaySettings(
  memberId: string,
  form: {
    homeAddress?: string | null;
    payPercent?: number | null;
    payFloor?: number | null;
    mileageRate?: number | null;
    homeRadiusMi?: number | null;
  },
): Promise<ActionResult> {
  const existing = await prisma.teamMember.findUnique({
    where: { id: memberId },
    select: { homeAddress: true, homeLat: true, homeLng: true },
  });
  if (!existing) return { ok: false, message: "Teammate not found." };

  const data: Record<string, unknown> = {
    payPercent: form.payPercent ?? null,
    payFloor: form.payFloor ?? null,
    mileageRate: form.mileageRate ?? 0.65,
    homeRadiusMi: form.homeRadiusMi ?? 35,
  };

  // Geocode the home address only when it changed (or coords are missing).
  const addr = (form.homeAddress ?? "").trim();
  data.homeAddress = addr || null;
  if (!addr) {
    data.homeLat = null;
    data.homeLng = null;
  } else if (addr !== (existing.homeAddress ?? "") || existing.homeLat == null) {
    const { geocodeAddress } = await import("@/lib/travel");
    const geo = await geocodeAddress(addr);
    if (!geo) {
      // Save the rest, but tell the user the address couldn't be located.
      await prisma.teamMember.update({ where: { id: memberId }, data });
      revalidatePath(`/team/${memberId}`);
      return { ok: false, message: "Saved rates, but couldn't locate that home address — check it for mileage to work." };
    }
    data.homeLat = geo.lat;
    data.homeLng = geo.lng;
  }

  await prisma.teamMember.update({ where: { id: memberId }, data });
  // Pay settings affect mileage radius → clear cached mileage for this member.
  await prisma.mileageDay.deleteMany({ where: { teamMemberId: memberId } });
  revalidatePath(`/team/${memberId}`);
  revalidatePath("/payouts");
  return { ok: true, message: "Pay settings saved." };
}
