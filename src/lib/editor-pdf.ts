import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";
import { format } from "date-fns";
import { DELIVERABLE_META, DELIVERABLE_STATUS_META } from "@/lib/pipeline";
import type { FullProject } from "@/lib/queries";
import { ActivityType } from "@prisma/client";
import { isFieldFlag } from "@/lib/debrief";
import { creativeCustomerNote } from "@/lib/clientNotes";
import { musicPickLine, readMusicPick } from "@/lib/musicPick";
import { EXPORT_SPEC, EXPORT_SPEC_LINES } from "@/lib/videoStyles";
import { etDate } from "@/lib/datetime";
import type { FilmingBrief, OutputBrief, ScriptDirection } from "@/lib/deliverableOutputs";
import type { BrandBrief } from "@/lib/brandProfile";

// Standard PDF fonts use WinAnsi encoding and throw on characters they can't
// represent (emoji, smart quotes from some keyboards, etc). Map the common ones
// and strip anything outside the encodable range so user notes never crash.
function clean(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/[–—]/g, "-")
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "");
}

// Flatten Markdown to readable plain text for the PDF: drop heading/bold/
// italic/quote markers, normalize bullets. Content and line structure are
// kept verbatim — only the syntax characters go.
function stripMarkdownSyntax(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^[\t ]*[-*•]\s+/gm, "- ");
}

const MARGIN = 56;
const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const BRAND = rgb(0.31, 0.275, 0.898); // #4f46e5
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.39, 0.45, 0.55);
const RULE = rgb(0.9, 0.91, 0.93);

/** Build a nicely formatted editor brief PDF. Returns the raw bytes.
 *
 *  `filming` is the content session's per-video brief (CP-09,
 *  deliverableOutputs.filmingBriefFor). Left out, it is read here — so the one
 *  route that prints this brief needs no change, and a caller that already has
 *  it (a drill, a batch) passes it in. null = print the plain count, as a
 *  listing shoot always has.
 *
 *  `outputs` (§7.5) and `brand` (§6.8) follow the same rule: each video's own
 *  brief with its version, and the client's brand kit — both read here when
 *  left out, money-scrubbed, and never a reason the brief fails to print. */
export async function buildEditorBriefPdf(
  project: FullProject,
  opts: { filming?: FilmingBrief | null; outputs?: OutputBrief[] | null; brand?: BrandBrief | null } = {},
): Promise<Uint8Array> {
  const briefs = await import("@/lib/deliverableOutputs");
  const [filming, outputs, brand] = await Promise.all([
    opts.filming !== undefined
      ? opts.filming
      // A brief with the plain count is better than no brief at all.
      : briefs.filmingBriefFor(project.id).catch(() => null),
    opts.outputs !== undefined ? opts.outputs : briefs.outputBriefsFor(project.id, { scrub: true }).catch(() => null),
    // links:false — a printed page cannot follow a link that expires in four
    // hours, and building the brief must never wait on Dropbox.
    opts.brand !== undefined
      ? opts.brand
      : import("@/lib/brandProfile").then((m) => m.brandBriefFor(project.client.id, { projectId: project.id, scrub: true, links: false })).catch(() => null),
  ]);
  const doc = await PDFDocument.create();
  doc.setTitle(`Editor Brief — ${project.title}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPageIfNeeded = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  const wrap = (text: string, f: PDFFont, size: number, maxW: number): string[] => {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(test, size) > maxW && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  const text = (
    content: string,
    opts: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; gap?: number; x?: number } = {},
  ) => {
    const size = opts.size ?? 11;
    const f = opts.f ?? font;
    const color = opts.color ?? INK;
    const x = opts.x ?? MARGIN;
    const maxW = PAGE_W - MARGIN - x;
    for (const line of wrap(clean(content), f, size, maxW)) {
      newPageIfNeeded(size + 4);
      page.drawText(line, { x, y: y - size, size, font: f, color });
      y -= size + (opts.gap ?? 4);
    }
  };

  const heading = (label: string) => {
    y -= 10;
    newPageIfNeeded(30);
    page.drawText(label.toUpperCase(), {
      x: MARGIN,
      y: y - 10,
      size: 10,
      font: bold,
      color: BRAND,
    });
    y -= 16;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 1,
      color: RULE,
    });
    y -= 10;
  };

  // ---- Header band ------------------------------------------------------
  page.drawRectangle({ x: 0, y: PAGE_H - 4, width: PAGE_W, height: 4, color: BRAND });
  text("RealTour Pilot — Editor Brief", { size: 9, f: bold, color: MUTED, gap: 2 });
  y -= 6;
  text(project.title, { size: 22, f: bold, gap: 2 });
  const addr = [project.addressLine, project.city, project.state, project.zip]
    .filter(Boolean)
    .join(", ");
  if (addr) text(addr, { size: 11, color: MUTED });

  // ---- Order facts ------------------------------------------------------
  heading("Shoot details");
  const fact = (label: string, value: string) => {
    newPageIfNeeded(16);
    page.drawText(clean(label), { x: MARGIN, y: y - 11, size: 10, font: bold, color: MUTED });
    page.drawText(clean(value), { x: MARGIN + 130, y: y - 11, size: 10, font, color: INK });
    y -= 18;
  };
  fact("Client", `${project.client.name}${project.client.company ? ` · ${project.client.company}` : ""}`);
  if (project.packageName) fact("Package", project.packageName);
  if (project.shootDate) fact("Shoot date", format(project.shootDate, "EEE, MMM d yyyy · h:mm a"));
  if (project.deliveryDue) fact("Delivery due", format(project.deliveryDue, "EEE, MMM d yyyy"));
  if (project.squareFeet) fact("Size", `${project.squareFeet.toLocaleString()} sq ft`);

  // ---- Deliverables -----------------------------------------------------
  heading("Deliverables to edit");
  for (const d of project.deliverables) {
    if (d.removedFromOrderAt) continue; // pulled from the Aryeo order — not work
    const meta = DELIVERABLE_META[d.type];
    const status = DELIVERABLE_STATUS_META[d.status].label;
    text(`•  ${meta.label}${d.quantity > 1 ? `  ×${d.quantity}` : ""}   (${status})`, {
      size: 11,
      f: bold,
      gap: 2,
    });
    if (d.notes) text(d.notes, { size: 10, color: MUTED, x: MARGIN + 14 });
  }

  // ---- How to export it -------------------------------------------------
  // The SAME EXPORT_SPEC the brief page, the upload panel and the Style Guide
  // print (lib/videoStyles). A printed brief is the copy most likely to be the
  // one still saying something older, so it reads from the same constant and
  // never gets its own wording.
  // Only on a job that owes video, the same gate the brief page uses (Sep 16
  // review): a photo-only brief telling a retoucher how to export from Final
  // Cut is a page of the wrong instructions in the one copy that gets printed
  // and kept.
  const owesVideo = project.deliverables.some(
    (d) => !d.removedFromOrderAt && (d.type === "VIDEO" || d.type === "SOCIAL_REEL"),
  );
  if (owesVideo) {
    heading("How to export");
    text(EXPORT_SPEC.headline, { size: 11, f: bold, gap: 3 });
    for (const line of EXPORT_SPEC_LINES) text(`-  ${line}`, { size: 10, gap: 3 });
  }

  // ---- Customer notes ----------------------------------------------------
  // THE customer note (generalNotes, mirrored to/from Aryeo; the retired
  // editingPreferences column is read as a fallback). Money-scrubbed: this PDF
  // is the editor's brief, and creatives never see pricing.
  const clientNote = creativeCustomerNote(project.client);
  if (clientNote) {
    heading("Customer notes");
    text(clientNote, { size: 11 });
  }

  // ---- Brand kit (§6.8, Sep 25) -----------------------------------------
  // The same registry read /edit shows (brandProfile.brandBriefFor): the
  // latest version of every brand file, fonts, music, the standing production
  // defaults and the accepted call preferences. The printed copy used to carry
  // none of it — the one copy an editor keeps beside Final Cut.
  const brandLines: string[] = [];
  if (brand) {
    if (brand.colors.length) brandLines.push(`Colors: ${brand.colors.map((x) => x.toUpperCase()).join(", ")}${brand.colorWords ? ` (${brand.colorWords})` : ""}`);
    if (brand.fontNames) brandLines.push(`Fonts: ${brand.fontNames}`);
    for (const f of brand.files) brandLines.push(`${f.typeWord}: ${f.name} (v${f.versionNo})`);
    if (brand.music) brandLines.push(`Music: ${brand.music}`);
    if (brand.videoStyle) brandLines.push(`Their style: ${brand.videoStyle}`);
    for (const d of brand.productionDefaults) brandLines.push(`${d.name}: ${d.text}`);
    for (const x of brand.acceptedPreferences) brandLines.push(`Preference: ${x}`);
  }
  if (brandLines.length) {
    heading("Brand kit");
    for (const l of brandLines) text(`-  ${l}`, { size: 10, gap: 3 });
  }

  // ---- Special requests -------------------------------------------------
  const requests = project.activities.filter((a) => a.type === ActivityType.SPECIAL_REQUEST);
  if (requests.length) {
    heading("Special requests");
    for (const r of requests) text(`•  ${r.body}`, { size: 11 });
  }

  // ---- Shot order (how to organize the gallery) -------------------------
  if (project.shotOrderNotes) {
    heading("Shot order");
    text(project.shotOrderNotes, { size: 11 });
  }

  // ---- Removal notes (photo retouch list) -------------------------------
  if (project.removalNotes) {
    heading("Remove in editing");
    text(project.removalNotes, { size: 11 });
  }

  // ---- Video: confirmed script + the photographer's instructions --------
  // CP-09: on a content session, WHICH video is which. The count alone ("4
  // videos were filmed - cut this many") left the editor to work out from the
  // clips which of the client's topics each one was, which words the client
  // approved, and what the photographer said about it on site. Each owed video
  // now carries its topic (titled as it reads now), the note, the script and
  // its raw folder — the same rows /edit and the project summary read.
  const filmedRows = filming?.rows ?? [];
  const pendingTopics = filming?.pending?.topics ?? [];
  if (filmedRows.length || pendingTopics.length) {
    heading("Videos filmed - one per topic");
    const n = project.videosFilmed ?? filmedRows.length;
    text(`${n} video${n === 1 ? "" : "s"} were filmed on this session - cut this many, one per topic below.`, { size: 11, gap: 6 });
    for (const r of filmedRows) {
      y -= 4;
      text(`${r.slotLabel ?? "Not on a slot yet"}: ${r.topicTitle}`, { size: 11, f: bold, gap: 2 });
      if (r.extra) {
        text(r.extra === "added_on_site" ? "Filmed on site - not on the month's plan (edit it like the others)." : "Beyond this month's plan (edit it like the others).", { size: 9, color: MUTED, x: MARGIN + 14, gap: 2 });
      }
      if (r.note) text(`Note from the shoot: ${r.note}`, { size: 10, x: MARGIN + 14, gap: 2 });
      if (r.script) {
        text(`Script: ${r.script.title}${r.script.versionNo ? ` (v${r.script.versionNo})` : ""} - ${r.script.standing}`, { size: 10, x: MARGIN + 14, gap: 2 });
        if (r.script.text) text(stripMarkdownSyntax(r.script.text), { size: 9, color: MUTED, x: MARGIN + 28, gap: 2 });
        for (const l of directionLines(r.script.direction)) text(l, { size: 9, x: MARGIN + 28, gap: 2 });
      } else {
        text("Script: none on file for this topic.", { size: 10, color: MUTED, x: MARGIN + 14, gap: 2 });
      }
      if (r.folder) text(`Raw clips: 02-RAW-Video/${r.folder.label}`, { size: 10, x: MARGIN + 14, gap: 2 });
    }
    if (filming && filming.slotsWithoutTopic > 0 && filmedRows.length) {
      y -= 4;
      text(`${filming.slotsWithoutTopic} more owed video${filming.slotsWithoutTopic === 1 ? " has" : "s have"} no topic recorded - ask the office which.`, { size: 10, color: MUTED });
    }
    // The photographer's report that has not landed yet: what they SAID, so
    // the editor is never told less than the person who was there.
    if (pendingTopics.length) {
      y -= 4;
      text(
        `Reported by the photographer, not recorded yet (${filming?.pending?.state === "NEEDS_REVIEW" ? "the office is recording these by hand" : "the hub is still saving these"}):`,
        { size: 10, f: bold, gap: 2 },
      );
      for (const t of pendingTopics) {
        text(`-  ${t.title}${t.extra ? " (filmed on site)" : ""}${t.note ? ` - ${t.note}` : ""}`, { size: 10, x: MARGIN + 14, gap: 2 });
      }
    }
  } else if (project.videosFilmed != null) {
    heading("Videos filmed");
    text(`${project.videosFilmed} video${project.videosFilmed === 1 ? "" : "s"} were filmed on this session - cut this many.`, { size: 11 });
  }
  // ---- Each video's brief (§7.5, Sep 25) ------------------------------
  // A reel and an MLS video on one order are separate briefs now. Printed when
  // any video has one of its own, or when the job owes more than one video —
  // then each says whether it goes by the shared instructions below. A
  // one-video job with no brief of its own prints exactly as it always did.
  const outs = outputs ?? [];
  if (outs.some((o) => o.directionSource === "own" || o.brandAsset) || outs.length > 1) {
    heading("Each video's brief");
    for (const o of outs) {
      y -= 4;
      text(`${o.index}. ${o.label}${o.format !== o.label ? ` - ${o.format}` : ""}`, { size: 11, f: bold, gap: 2 });
      text(o.versionLabel, { size: 9, color: MUTED, x: MARGIN + 14, gap: 2 });
      for (const sec of o.sections) text(`${sec.label}: ${sec.text}`, { size: 10, x: MARGIN + 14, gap: 2 });
      text(`Chosen logo / branding card: ${o.brandAsset ? `${o.brandAsset.name}${o.brandAsset.versionNo ? ` v${o.brandAsset.versionNo}` : ""}${o.brandAsset.fileName ? ` - ${o.brandAsset.fileName}` : ""}${o.brandAsset.state !== "current" ? " - no longer current; confirm with Kyle" : ""}` : "not recorded for this video"}`, { size: 10, x: MARGIN + 14, gap: 2 });
      const due = o.promisedAtISO ? etDate(o.promisedAtISO) : null; // ET, not the server's clock
      const who = [o.reviewer ? `Reviewer: ${o.reviewer.name}${o.reviewer.from === "chain" ? " (first in line)" : ""}` : null, due ? `Due ${due}` : null].filter(Boolean).join("  ·  ");
      if (who) text(who, { size: 9, color: MUTED, x: MARGIN + 14, gap: 2 });
    }
  }
  if (project.videoInstructions) {
    heading(outs.length > 1 ? "Video - instructions from the shoot (all videos)" : "Video - instructions from the shoot");
    text(project.videoInstructions, { size: 11 });
  }
  if (project.scriptConfirmNote) {
    heading("Video script");
    text(`Script status: ${project.scriptConfirmNote}`, { size: 11 });
    // Studio scripts are Markdown — flatten the syntax for the plain-text PDF
    // (a literal "**Hook**" or "## " in the editor's hands reads as noise).
    if (project.reelScript) text(stripMarkdownSyntax(project.reelScript), { size: 10 });
  }

  // ---- Music ------------------------------------------------------------
  // The Epidemic Sound track picked on the brief's Music card (Sep 15) — the
  // same line the card and the spec show, plus where the MP3 sits.
  const music = readMusicPick(project.editSpec);
  if (music) {
    heading("Music");
    text(musicPickLine(music), { size: 11, f: bold, gap: 2 });
    text(
      music.dropboxPath
        ? `In the job folder: 02-RAW-Video/Music/${music.dropboxPath.split("/").pop() ?? ""}`
        : `Picked by ${music.pickedBy || "the office"} - not downloaded yet; use the Music card on the job page.`,
      { size: 10, color: MUTED },
    );
  }

  // ---- Photographer's brief --------------------------------------------
  if (project.editorBrief) {
    heading("Photographer's notes");
    text(project.editorBrief, { size: 11 });
  }

  // ---- Flags ------------------------------------------------------------
  // Human field flags only — a machine-written client revision row would print
  // an entire email thread under "Flagged issues" in the editor's brief.
  const flags = project.activities.filter((a) => a.type === ActivityType.FLAG && isFieldFlag(a.body));
  if (flags.length) {
    heading("Flagged issues");
    for (const fl of flags)
      text(`!  ${fl.body}`, { size: 11, color: rgb(0.86, 0.15, 0.15) });
  }

  // ---- Footer -----------------------------------------------------------
  drawFooter(page, font, project.title);

  return doc.save();
}

/** A script version's production direction as printable lines (§6.8). */
function directionLines(d: ScriptDirection | null | undefined): string[] {
  if (!d) return [];
  return [
    d.filmingNotes ? `Filming: ${d.filmingNotes}` : null,
    d.creativeDirection ? `Direction: ${d.creativeDirection}` : null,
    d.productionNotes ? `Production: ${d.productionNotes}` : null,
  ].filter((x): x is string => !!x);
}

function drawFooter(page: PDFPage, font: PDFFont, title: string) {
  page.drawText(`Generated by RealTour Pilot Ops Hub - ${title}`.replace(/[^\x20-\xFF]/g, ""), {
    x: MARGIN,
    y: 30,
    size: 8,
    font,
    color: MUTED,
  });
}
