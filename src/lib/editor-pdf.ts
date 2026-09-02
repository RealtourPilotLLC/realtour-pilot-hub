import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";
import { format } from "date-fns";
import { DELIVERABLE_META, DELIVERABLE_STATUS_META } from "@/lib/pipeline";
import type { FullProject } from "@/lib/queries";
import { ActivityType } from "@prisma/client";
import { isFieldFlag } from "@/lib/debrief";
import { creativeCustomerNote } from "@/lib/clientNotes";

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

/** Build a nicely formatted editor brief PDF. Returns the raw bytes. */
export async function buildEditorBriefPdf(project: FullProject): Promise<Uint8Array> {
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

  // ---- Customer notes ----------------------------------------------------
  // THE customer note (generalNotes, mirrored to/from Aryeo; the retired
  // editingPreferences column is read as a fallback). Money-scrubbed: this PDF
  // is the editor's brief, and creatives never see pricing.
  const clientNote = creativeCustomerNote(project.client);
  if (clientNote) {
    heading("Customer notes");
    text(clientNote, { size: 11 });
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
  if (project.videosFilmed != null) {
    heading("Videos filmed");
    text(`${project.videosFilmed} video${project.videosFilmed === 1 ? "" : "s"} were filmed on this session - cut this many.`, { size: 11 });
  }
  if (project.videoInstructions) {
    heading("Video - instructions from the shoot");
    text(project.videoInstructions, { size: 11 });
  }
  if (project.scriptConfirmNote) {
    heading("Video script");
    text(`Script status: ${project.scriptConfirmNote}`, { size: 11 });
    // Studio scripts are Markdown — flatten the syntax for the plain-text PDF
    // (a literal "**Hook**" or "## " in the editor's hands reads as noise).
    if (project.reelScript) text(stripMarkdownSyntax(project.reelScript), { size: 10 });
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

function drawFooter(page: PDFPage, font: PDFFont, title: string) {
  page.drawText(`Generated by RealTour Pilot Ops Hub - ${title}`.replace(/[^\x20-\xFF]/g, ""), {
    x: MARGIN,
    y: 30,
    size: 8,
    font,
    color: MUTED,
  });
}
