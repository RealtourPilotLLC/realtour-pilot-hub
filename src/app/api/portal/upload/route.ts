import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { portalEnrollment } from "@/lib/portal";
import { dropboxUpload } from "@/lib/integrations/dropbox";
import { ensureClientBrandFolder } from "@/lib/clientFolders";

export const runtime = "nodejs";
export const maxDuration = 60;

// Client uploads a brand asset (logo, headshot, font, brand kit) from their
// PORTAL into their own Dropbox asset folder — the same folder the editors
// and the hub already read. PUBLIC route: the enrollment token is the auth,
// so the guards are tight — type allowlist, 25MB cap, sanitized names, and a
// per-client daily counter so a leaked link can't fill the Dropbox.
const MAX_BYTES = 25 * 1024 * 1024;
const DAILY_CAP = 25;
const NAME_OK = /^[^\\/:?*"<>|]{1,180}$/;
const EXT_OK = /\.(png|jpe?g|webp|heic|gif|svg|pdf|zip|otf|ttf|woff2?|mp4|mov)$/i;

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, message: "Bad upload." }, { status: 400 });
  }
  const token = String(form.get("token") ?? "");
  const enrollment = await portalEnrollment(token);
  if (!enrollment) return NextResponse.json({ ok: false, message: "This link is no longer active." }, { status: 401 });

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, message: "Pick a file first." }, { status: 400 });
  if (!NAME_OK.test(file.name) || !EXT_OK.test(file.name)) {
    return NextResponse.json({ ok: false, message: "That file type isn't supported — images, PDFs, fonts, zips and videos work." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, message: "Max 25MB per file — text us for anything bigger." }, { status: 400 });
  }

  // Daily flood counter — ATOMIC increment-then-check (review: the read-check-
  // write version raced under concurrency and a leaked link could blow past
  // the cap). The increment happens in one statement; the post-increment value
  // decides. Over-cap attempts still consume a count, which only tightens the
  // limit. Fail CLOSED: if the counter can't be read, no upload.
  const day = new Date().toISOString().slice(0, 10);
  const capKey = `portal-uploads-${enrollment.id}-${day}`;
  try {
    await prisma.appSetting.upsert({ where: { key: capKey }, update: {}, create: { key: capKey, value: "0" } });
    const rows = await prisma.$queryRaw<{ value: string }[]>`
      UPDATE "AppSetting" SET "value" = (COALESCE(NULLIF("value", ''), '0')::int + 1)::text
      WHERE "key" = ${capKey} RETURNING "value"`;
    const used = parseInt(rows[0]?.value ?? "", 10);
    if (!Number.isFinite(used)) throw new Error("counter unreadable");
    if (used > DAILY_CAP) {
      return NextResponse.json({ ok: false, message: "That's the daily upload limit — text us and we'll add the rest." }, { status: 429 });
    }
  } catch {
    return NextResponse.json({ ok: false, message: "Uploads are briefly unavailable — try again in a minute." }, { status: 503 });
  }

  const folder = await ensureClientBrandFolder(enrollment.clientId);
  if (!folder.ok || !folder.path) {
    return NextResponse.json({ ok: false, message: "We couldn't reach the asset folder — text us the file instead." }, { status: 502 });
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await dropboxUpload(`${folder.path}/${file.name}`, bytes); // autorename on collision
  } catch {
    return NextResponse.json({ ok: false, message: "The upload didn't stick — try again, or text us the file." }, { status: 502 });
  }

  try {
    const { notifyInApp } = await import("@/lib/notify");
    const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true } });
    await notifyInApp({
      kind: "portal_asset",
      title: `New brand asset — ${client?.name ?? "a client"}`,
      body: file.name,
      href: `/clients/${enrollment.clientId}`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `portal-asset-${enrollment.id}-${day}`,
    });
  } catch { /* bell is best-effort */ }

  return NextResponse.json({ ok: true, message: `${file.name} added to your brand kit.` });
}
