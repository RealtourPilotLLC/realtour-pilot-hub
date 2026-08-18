import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guards";
import { dropboxUpload } from "@/lib/integrations/dropbox";
import { ensureClientBrandFolder } from "@/lib/clientFolders";

export const runtime = "nodejs";
export const maxDuration = 60;

// Upload a client asset (logo, endcard, font, brand kit) into the client's
// Dropbox asset folder. OWNER/ADMIN and EDITORS (Jordan: "I want the editors
// to be able to upload assets as well as the owner and admin"). An API route,
// not a server action — server actions cap the body at ~1MB and logo/endcard
// files easily exceed it. Behind the login gate like every /api route.
const MAX_BYTES = 60 * 1024 * 1024; // 60MB — endcard videos fit, raw footage doesn't
const NAME_OK = /^[^\\/:?*"<>|]{1,180}$/;

export async function POST(req: NextRequest) {
  try {
    await requireRole(["OWNER", "ADMIN", "EDITOR"]);
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, message: "Bad upload." }, { status: 400 });
  }
  const clientId = String(form.get("clientId") ?? "");
  const file = form.get("file");
  if (!clientId || !(file instanceof File)) {
    return NextResponse.json({ ok: false, message: "Pick a file first." }, { status: 400 });
  }
  if (!NAME_OK.test(file.name)) {
    return NextResponse.json({ ok: false, message: "That file name has characters Dropbox can't take." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, message: "Max 60MB per asset — put bigger files in the folder via Dropbox directly." }, { status: 400 });
  }

  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
  if (!client) return NextResponse.json({ ok: false, message: "Client not found." }, { status: 404 });

  const folder = await ensureClientBrandFolder(clientId);
  if (!folder.ok || !folder.path) {
    return NextResponse.json({ ok: false, message: folder.message }, { status: 502 });
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await dropboxUpload(`${folder.path}/${file.name}`, bytes); // autorename on collision
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 502 });
  }

  return NextResponse.json({ ok: true, message: `${file.name} uploaded to ${client.name}'s assets.` });
}
