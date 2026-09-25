import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePortalViewer } from "@/lib/portal";
import { can, refusalMessage } from "@/lib/portalAccess";
import { dropboxUpload } from "@/lib/integrations/dropbox";
import { ensureClientBrandFolder } from "@/lib/clientFolders";
import { isPortalUploadKind, recordPortalAssetUpload, replaceableAsset } from "@/lib/brandProfile";

export const runtime = "nodejs";
export const maxDuration = 60;

// Client uploads a brand asset (logo, headshot, font, brand kit) from their
// PORTAL into their own Dropbox asset folder — the same folder the editors
// and the hub already read. PUBLIC route: the visit is identified the same
// three ways as every portal action (the link's token in the form body, the
// signed-in person's cookie, or staff through the owner iframe) and gated by
// the brand-profile permission — so the guards are tight — type allowlist,
// 25MB cap, sanitized names, and a per-client daily counter so a leaked link
// can't fill the Dropbox.
//
// CP-06 (Sep 24 2026): the file is now also RECORDED. Dropbox stays the file
// store, but until today a portal upload landed there and nowhere else — no
// registry row, so the staff Brand tab, the setup checklist and the editor's
// brief never knew a logo had arrived, and the only signal was an owner bell.
// The form says what the file IS (`kind`: LOGO | HEADSHOT | FONT | OTHER) and,
// for a Replace, which of the client's own assets it replaces (`assetId`);
// the path recorded is the one Dropbox actually wrote (autorename can turn
// "logo.png" into "logo (1).png"). recordPortalAssetUpload does the rest —
// the history row, the editor's banner, Kyle's confirmation task.
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
  const enrollmentId = String(form.get("enrollmentId") ?? "") || null;
  const r = await resolvePortalViewer({ token: token || null, enrollmentId, cookies: req.cookies });
  if (!r.ok) return NextResponse.json({ ok: false, message: "This link is no longer active — sign in with your email to continue." }, { status: 401 });
  if (!can(r.viewer, "editBrandProfile")) return NextResponse.json({ ok: false, message: refusalMessage(r.viewer, "editBrandProfile") }, { status: 403 });
  const { enrollment } = r.viewer;

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, message: "Pick a file first." }, { status: 400 });
  // An older page sends no kind: it is filed as OTHER, never guessed.
  const kind = String(form.get("kind") ?? "") || "OTHER";
  if (!isPortalUploadKind(kind)) return NextResponse.json({ ok: false, message: "Pick what this file is: logo, headshot, font or other." }, { status: 400 });
  // A Replace must name one of THIS client's own files — checked before a
  // single byte goes to Dropbox, so a forged id cannot even use the quota.
  const replaceId = String(form.get("assetId") ?? "") || null;
  if (replaceId && !(/^[a-z0-9]{10,40}$/i.test(replaceId) && (await replaceableAsset(enrollment.clientId, replaceId)))) {
    return NextResponse.json({ ok: false, message: "That file isn't on your profile any more — upload it as a new one instead." }, { status: 400 });
  }
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
  let landedAt: string;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    landedAt = (await dropboxUpload(`${folder.path}/${file.name}`, bytes)).pathDisplay; // autorename on collision
  } catch {
    return NextResponse.json({ ok: false, message: "The upload didn't stick — try again, or text us the file." }, { status: 502 });
  }
  const landedName = landedAt.slice(landedAt.lastIndexOf("/") + 1) || file.name;

  // The file is safely in their folder whatever happens next. If recording it
  // fails, say so honestly rather than claiming it reached the profile; the
  // staff Brand tab lists it as "in the folder, not tracked", one click to file.
  const recorded = await recordPortalAssetUpload(r.viewer, {
    kind, fileName: landedName, path: landedAt, sizeBytes: file.size, mimeType: file.type || null, replaceAssetId: replaceId,
  }).catch((e) => {
    console.error("[portal upload] registry write failed", e);
    return { ok: false, message: "", assetId: undefined, versionId: undefined };
  });

  try {
    const { notifyInApp } = await import("@/lib/notify");
    const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true } });
    await notifyInApp({
      kind: "portal_asset",
      title: `New brand asset — ${client?.name ?? "a client"}`,
      body: `${kind.toLowerCase()}: ${landedName}`,
      href: `/clients/${enrollment.clientId}`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `portal-asset-${enrollment.id}-${day}`,
    });
  } catch { /* bell is best-effort */ }

  if (!recorded.ok) {
    return NextResponse.json({ ok: true, registered: false, message: `${landedName} is in your brand folder, where your editor can find it, but it didn't show up on your profile. Refresh, and text us if it's still missing.` });
  }
  return NextResponse.json({ ok: true, registered: true, message: recorded.message, assetId: recorded.assetId, versionId: recorded.versionId, kind, fileName: landedName });
}
