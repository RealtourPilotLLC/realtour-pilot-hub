import "server-only";

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { scriptBlocksFromParts, scriptBlocksFromText, lineShape, type ScriptLayout, type ScriptParts } from "@/lib/scriptLayout";

// ---------------------------------------------------------------------------
// SCRIPTS AS A PDF (Oct 14 2026). Jordan: "make sure that the agents are able
// to download their scripts in a nice PDF format" and the photographers too,
// on the shoot page, and to text the PDF to the agent.
//
// One script per page, in the hub's own section labels (Hook, Talking Point 1:
// Re-hook, Close / Call to action, Caption CTA), large readable type for
// reading on a phone or off a printout, and the Realtour Pilot name on top.
// Standard PDF fonts only (no font files to ship), so text is cleaned to what
// they can draw: smart quotes straightened, dashes made commas (no dashes in
// scripts), anything else outside Latin-1 dropped.
// ---------------------------------------------------------------------------

export type PdfScript = {
  title: string;
  pillarName?: string | null;
  /** The structured script (preferred). */
  parts?: ScriptParts | null;
  /** A plain body (historical imports, skits read as written). */
  body?: string | null;
  /** A short line under the title ("Approved Oct 14", "Edited on site"). */
  note?: string | null;
};

const BRAND = rgb(0.957, 0.396, 0.157); // Realtour Pilot orange
const INK = rgb(0.09, 0.11, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.88, 0.89, 0.91);
const NAVY = rgb(0.06, 0.09, 0.16);
const W = 612; // US Letter
const H = 792;
const M = 54;

export function pdfText(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, "...")
    .replace(/\s*[–—―]\s*/g, ", ")
    .replace(/•/g, "-")
    .replace(/ /g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) out.push(line);
        // A single word wider than the line is cut, never overflows.
        let rest = w;
        while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
          let cut = rest.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
          out.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export async function buildScriptsPdf(input: { heading: string; subheading?: string | null; scripts: PdfScript[]; footer?: string | null }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfText(input.heading));
  doc.setAuthor("Realtour Pilot");
  doc.setCreator("Realtour Pilot Operations Hub");
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ital = await doc.embedFont(StandardFonts.HelveticaOblique);
  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  const header = (p: PDFPage) => {
    p.drawRectangle({ x: 0, y: H - 64, width: W, height: 64, color: NAVY });
    p.drawRectangle({ x: 0, y: H - 68, width: W, height: 4, color: BRAND });
    p.drawText("REALTOUR", { x: M, y: H - 40, size: 15, font: bold, color: rgb(1, 1, 1) });
    p.drawText("PILOT", { x: M + bold.widthOfTextAtSize("REALTOUR", 15) + 2, y: H - 40, size: 15, font: bold, color: BRAND });
    const h = pdfText(input.heading);
    const hw = reg.widthOfTextAtSize(h, 10);
    p.drawText(h, { x: Math.max(M + 130, W - M - hw), y: H - 38, size: 10, font: reg, color: rgb(0.85, 0.87, 0.9) });
  };
  const newPage = () => {
    page = doc.addPage([W, H]);
    pages.push(page);
    header(page);
    y = H - 100;
  };
  const ensure = (need: number) => {
    if (y - need < M + 24) newPage();
  };
  const para = (text: string, font: PDFFont, size: number, color = INK, leading = size * 1.45, indent = 0) => {
    for (const line of wrap(pdfText(text), font, size, W - 2 * M - indent)) {
      ensure(leading);
      page.drawText(line, { x: M + indent, y, size, font, color });
      y -= leading;
    }
  };

  if (!input.scripts.length) {
    newPage();
    para("No scripts to show yet.", reg, 13, MUTED);
  }
  input.scripts.forEach((s, i) => {
    newPage();
    if (i === 0 && input.subheading) {
      para(input.subheading, reg, 10, MUTED);
      y -= 10;
    }
    para(s.title || `Script ${i + 1}`, bold, 20, INK, 26);
    const meta = [s.pillarName ? `Pillar: ${s.pillarName}` : null, s.note].filter(Boolean).join("  ·  ");
    if (meta) para(meta, reg, 10, MUTED, 14);
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: RULE });
    y -= 18;
    const layout: ScriptLayout = s.parts && (s.parts.hook || s.parts.points.length || s.parts.close) ? scriptBlocksFromParts(s.parts, { pillarName: s.pillarName ?? null }) : scriptBlocksFromText(s.body ?? "");
    // A spoken line large; a [stage direction] smaller, in italics.
    const lines = (ls: ScriptLayout["lead"]) => {
      for (const l of ls) {
        if (l.kind === "space") { y -= 6; continue; }
        const texts = l.kind === "para" ? [l.text] : l.items.map((it) => `${it.marker} ${it.text}`);
        for (const t of texts) {
          const shape = lineShape(t);
          if (shape.kind === "direction") para(shape.text, ital, 12, MUTED, 17);
          else if (shape.speaker) para(`${shape.speaker}: ${shape.text}`, reg, 14, INK, 20);
          else para(t, reg, 14, INK, 20);
        }
      }
    };
    lines(layout.lead);
    if (layout.lead.length) y -= 10;
    for (const sec of layout.sections) {
      ensure(40);
      para(sec.label.toUpperCase(), bold, 10, BRAND, 15);
      y -= 2;
      lines(sec.lines);
      y -= 10;
    }
  });
  const foot = pdfText(input.footer ?? "Realtour Pilot Team");
  pages.forEach((p, i) => {
    p.drawText(foot, { x: M, y: 30, size: 9, font: reg, color: MUTED });
    const n = `${i + 1} / ${pages.length}`;
    p.drawText(n, { x: W - M - reg.widthOfTextAtSize(n, 9), y: 30, size: 9, font: reg, color: MUTED });
  });
  return doc.save();
}
