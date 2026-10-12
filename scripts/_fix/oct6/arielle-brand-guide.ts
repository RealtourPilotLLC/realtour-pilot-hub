// Oct 12 2026 (Jordan): "here is Arielle Roemer's brand guide. Can you please
// add these to her content program brand profile so that most of it is
// pre-filled when she signs up?"
//
// From "Arielle Roemer Brand Guide (1).pdf" (2 pages):
//   · Brand colors (Client.brandColors): white, black, accent pink #ECE3E5.
//     The guide gives "White #" with no code; white is #FFFFFF.
//   · Fonts slot: titles Maharlika; headings, subheadings and body Neue Montreal.
//   · Website slot: https://arielleroemer.com/
//   · Social slot: Instagram, Facebook, LinkedIn, YouTube.
//   · Working preferences (Client.portalPreferences): the pages she wants
//     traffic driven to, and her team's landing pages. No other field holds
//     links, and this one is on the brief and editable by her on the portal.
//   · Files: the PNG logos and the three team headshots from the Google Drive
//     folders the guide links to, copied into her brand folder
//     (/AutoHDR/Client Assets/Arielle Roemer) and filed as LOGO / HEADSHOT
//     assets. The JPG/PDF/EPS/AI duplicates and zips stay in her Drive.
//
// Every change leaves a ClientBrandChange row (source staff) like an edit on
// the Brand tab, and one alertBrandChanges call at the end (one task for Kyle,
// one editor note). Nothing is sent to the client. Re-running skips what is
// already on file (same value, or a file already filed by name).
//
//   set -a && source .env; set +a
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct6/arielle-brand-guide.ts            DRY RUN
//   … --apply                                                                                         writes
import { prisma } from "@/lib/prisma";

const CLIENT_ID = "cmt7msalo000b9kg1kuk666hf"; // Arielle Roemer
const ENROLLMENT_ID = "cmt7msany000c9kg1ospdeoza";

const BRAND_COLORS = "#FFFFFF, #000000, #ECE3E5, primary white and black; accent pink"; // the form drops commas from the words after the swatches; a semicolon survives
const FONTS = "Titles: Maharlika. Headings, subheadings and body: Neue Montreal.";
const WEBSITE = "https://arielleroemer.com/";
const SOCIAL = {
  instagram: "https://www.instagram.com/arielleroemer/",
  facebook: "https://www.facebook.com/arielle.kaplowitz",
  linkedin: "https://www.linkedin.com/in/arielle-roemer-56053a3/",
  youtube: "https://www.youtube.com/channel/UCp48_72qPD-q9NHanzOg9vQ",
};
const PREFERENCES = [
  "Pages to send viewers to:",
  "Sellers: https://arielleroemer.com/sellers",
  "Buyers: https://arielleroemer.com/buyers",
  "Blog: https://arielleroemer.com/blog",
  "Press: https://arielleroemer.com/press",
  "Property videos: https://arielleroemer.com/propertyvideos",
  "Testimonials: https://arielleroemer.com/testimonials",
  "",
  "Team pages:",
  "About: https://arielleroemer.com/about",
  "Emma Hobby: https://www.foxroach.com/bio/emmahobby",
  "Lyda Mar Orjuela: https://www.foxroach.com/bio/lydamarorjuela",
].join("\n");

const LOGO_FOLDER = "https://drive.google.com/drive/folders/1c4SHHvpGcqFuQ7wTsU2Q27-Omf9j8jga";
const EMBLEM_FOLDER = "https://drive.google.com/drive/folders/18QlyMP3mOwSqTmAPIZjLvyOBbQDw71X6";
const HEADSHOT_FOLDER = "https://drive.google.com/drive/folders/1SFXIlcdl50QNGGA7K7zED1aXtiMQU_qw";
const FILES: { driveId: string; fileName: string; type: "LOGO" | "HEADSHOT"; name: string; mime: string; folder: string }[] = [
  { driveId: "1QhISONBhaBxM74reKLqtI6KBYOQFA818", fileName: "RITT_RoemerA_WhiteLogo.png", type: "LOGO", name: "Team logo (white)", mime: "image/png", folder: LOGO_FOLDER },
  { driveId: "1x3XaPOVaSHrP-LTm7vhPkPTb4iR28V4E", fileName: "RITT_RoemerA_WhiteLogo_justname.png", type: "LOGO", name: "Team logo, name only (white)", mime: "image/png", folder: LOGO_FOLDER },
  { driveId: "1YWAQrejg-75sM-d0G7tR7cc5HopUin3t", fileName: "RITT_RoemerA_BlackLogo.png", type: "LOGO", name: "Team logo (black)", mime: "image/png", folder: LOGO_FOLDER },
  { driveId: "1nFKRWFHfmPTiMge6P4W5_JdI2z3NR1Oj", fileName: "RITT_RoemerA_BlackLogo_justname.png", type: "LOGO", name: "Team logo, name only (black)", mime: "image/png", folder: LOGO_FOLDER },
  { driveId: "1eXi5ACN29hCien_pQcntJosEHbaLJjOa", fileName: "RITT_RoemerA_BlackBckrndLogo.png", type: "LOGO", name: "Team logo on black background", mime: "image/png", folder: LOGO_FOLDER },
  { driveId: "18RhNb5yzySeRBtn-beoCpcNXt0OEKTZb", fileName: "F&R_Arielle Roemer Emblem.png", type: "LOGO", name: "AR emblem", mime: "image/png", folder: EMBLEM_FOLDER },
  { driveId: "1zg1v78-_WZ61RKmfYktcV4gdYRfeatm6", fileName: "Arielle Roemer hs v1square.png", type: "HEADSHOT", name: "Arielle Roemer headshot", mime: "image/png", folder: HEADSHOT_FOLDER },
  { driveId: "1HjhCRoE3UierdglrvPpL_ns_lAykQx7-", fileName: "Lyda Mar Orjuela hs.jpg", type: "HEADSHOT", name: "Lyda Mar Orjuela headshot (team)", mime: "image/jpeg", folder: HEADSHOT_FOLDER },
  { driveId: "1zY0Ox4rjJn9VeOTtv-VKL0M5Zk3tEmtB", fileName: "Emma Hobby hs 2026.JPG", type: "HEADSHOT", name: "Emma Hobby headshot (team)", mime: "image/jpeg", folder: HEADSHOT_FOLDER },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const bp = await import("@/lib/brandProfile");
  const client = await prisma.client.findUnique({ where: { id: CLIENT_ID }, select: { name: true, brandColors: true, portalPreferences: true } });
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { id: ENROLLMENT_ID }, select: { clientId: true, status: true } });
  if (!client || client.name !== "Arielle Roemer" || enrollment?.clientId !== CLIENT_ID) throw new Error("Not Arielle Roemer's records — stopping.");
  const me = await prisma.appUser.findFirst({ where: { email: "info@realtourpilot.com" }, select: { id: true, email: true } });
  const staff = { staffEmail: me?.email ?? "info@realtourpilot.com", staffUserId: me?.id ?? null, label: "Jordan Spackman (from Arielle's brand guide)" };
  console.log(`${client.name} · enrollment ${enrollment.status}${apply ? "" : " · DRY RUN"}`);

  // ---- the two columns ----------------------------------------------------
  const columns = [
    { column: "brandColors" as const, label: "Brand colors", value: BRAND_COLORS, current: client.brandColors },
    { column: "portalPreferences" as const, label: "Working preferences", value: PREFERENCES, current: client.portalPreferences },
  ];
  for (const c of columns) {
    if (c.current) { console.log(`  ${c.label}: already set, left alone (${JSON.stringify(c.current.slice(0, 60))})`); continue; }
    console.log(`  ${c.label}: ${JSON.stringify(c.value.slice(0, 80))}${c.value.length > 80 ? "…" : ""}`);
    if (!apply) continue;
    await prisma.$transaction(async (tx) => {
      await tx.client.update({ where: { id: CLIENT_ID }, data: { [c.column]: c.value } });
      await bp.recordBrandChange({ clientId: CLIENT_ID, enrollmentId: ENROLLMENT_ID, fieldKey: c.column, label: c.label, kind: "SET", fromText: null, toText: c.value, source: "staff", staffUserId: staff.staffUserId, actorLabel: staff.label }, tx);
    });
  }

  // ---- the slots ------------------------------------------------------------
  const slots: { key: "fonts" | "website" | "social"; value: string }[] = [
    { key: "fonts", value: FONTS },
    { key: "website", value: WEBSITE },
    { key: "social", value: bp.socialToText(SOCIAL) },
  ];
  for (const s of slots) {
    const cur = await bp.getSlot(CLIENT_ID, s.key);
    if (cur?.value) { console.log(`  ${s.key}: already set, left alone`); continue; }
    console.log(`  ${s.key}: ${JSON.stringify(s.value)}`);
    if (!apply) continue;
    await bp.setProfileSlot({ clientId: CLIENT_ID, enrollmentId: ENROLLMENT_ID, key: s.key, value: s.value, source: "staff", actor: staff });
  }

  // ---- the files --------------------------------------------------------------
  const { ownerGoogleToken } = await import("@/lib/integrations/google");
  const { ensureClientBrandFolder } = await import("@/lib/clientFolders");
  const { dropboxUpload } = await import("@/lib/integrations/dropbox");
  const { createAssetWithVersion } = await import("@/lib/clientAssets");
  const token = await ownerGoogleToken();
  if (!token) throw new Error("Google isn't connected, so the Drive files can't be read.");
  const filed = await prisma.clientAsset.findMany({ where: { clientId: CLIENT_ID, type: { in: ["LOGO", "HEADSHOT"] } }, select: { id: true, activeVersionId: true } });
  const filedNames = new Set((await prisma.clientAssetVersion.findMany({ where: { assetId: { in: filed.map((a) => a.id) } }, select: { fileName: true } })).map((v) => (v.fileName ?? "").toLowerCase()));
  const folder = apply ? await ensureClientBrandFolder(CLIENT_ID) : { ok: true, path: "/AutoHDR/Client Assets/Arielle Roemer" };
  if (!folder.ok || !folder.path) throw new Error(`Brand folder: ${"message" in folder ? folder.message : "unavailable"}`);
  for (const f of FILES) {
    if (filedNames.has(f.fileName.toLowerCase())) { console.log(`  ${f.type} ${f.fileName}: already filed, skipped`); continue; }
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.driveId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { console.log(`  ${f.type} ${f.fileName}: Drive answered ${res.status}, skipped`); continue; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    console.log(`  ${f.type} "${f.name}" ← ${f.fileName} (${Math.round(bytes.byteLength / 1024)} KB)`);
    if (!apply) continue;
    const landed = (await dropboxUpload(`${folder.path}/${f.fileName}`, bytes)).pathDisplay;
    await prisma.$transaction(async (tx) => {
      const r = await createAssetWithVersion({
        clientId: CLIENT_ID, enrollmentId: ENROLLMENT_ID, type: f.type, name: f.name, ownership: "CLIENT",
        notes: `From Arielle's brand guide (Oct 12 2026). Original folder: ${f.folder}`,
        source: "import", fileRef: landed, fileName: f.fileName, mimeType: f.mime, sizeBytes: bytes.byteLength, by: staff.staffEmail,
      }, tx);
      await bp.recordBrandChange({ clientId: CLIENT_ID, enrollmentId: ENROLLMENT_ID, fieldKey: `asset:${f.type}`, label: f.type === "LOGO" ? "Logo" : "Headshot", kind: "FILE_ADDED", fromText: null, toText: f.fileName, assetId: r.assetId, assetVersionId: r.versionId, source: "staff", staffUserId: staff.staffUserId, actorLabel: staff.label }, tx);
    });
    console.log(`     filed at ${landed}`);
  }

  if (apply) {
    const a = await bp.alertBrandChanges(CLIENT_ID).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    console.log(`brand-change alert: ${JSON.stringify(a)}`);
  } else {
    console.log("DRY RUN: nothing written. Re-run with --apply.");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
