// ---------------------------------------------------------------------------
// FILE → PLAIN TEXT, in one place (A08, Sep 25 2026).
//
// The strategy upload and the Import tab read a PDF, a Word file or a text
// file with pdf-parse / mammoth; that code lived inside content/actions.ts,
// where nothing else could reach it. The strategy reference manifest
// (scripts/strategy-reference-manifest.ts) must read Jordan's reference
// documents the SAME way an upload does — otherwise "the manifest's headings"
// and "what the parser sees when he uploads that file" could differ — so the
// extraction lives here and both call it.
//
// Pure Node: no database, no network, no secrets. Deliberately not
// "server-only" so the local manifest script can run it under plain tsx.
// ---------------------------------------------------------------------------

export type ExtractedText = { ok: true; text: string } | { ok: false; message: string };

/** The largest file either caller accepts (the upload says so in words). */
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------------------
// PDFs IN PRODUCTION (Oct 12 2026). Jordan: "the upload does not accept PDFs".
// It did on this machine and refused every PDF on the live site, where the
// log read: Cannot load "@napi-rs/canvas" … Cannot polyfill `DOMMatrix`. The
// PDF engine inside pdf-parse (pdfjs) builds a DOMMatrix the moment it loads
// and, on Node, borrows that class from @napi-rs/canvas, a native module the
// deployed bundle does not carry. Without it the import throws
// "DOMMatrix is not defined" and the file is refused before a page is read.
//
// Reading TEXT never draws anything, so a plain 2-D matrix is all pdfjs needs
// (rendering would; nothing here renders). The worker is loaded by name here
// too, so the bundler ships it: on Node, pdfjs otherwise imports
// "./pdf.worker.mjs" by a path built at run time, which a bundle's file
// tracing cannot see. Both only fill what is missing — where the real classes
// exist (a browser, a machine with the canvas module) they are left alone.
// ---------------------------------------------------------------------------
class PlainMatrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  constructor(init?: number[] | string) {
    if (Array.isArray(init) && init.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = init.map(Number);
  }
  get m11() { return this.a; } get m12() { return this.b; } get m21() { return this.c; } get m22() { return this.d; } get m41() { return this.e; } get m42() { return this.f; }
  get is2D() { return true; }
  get isIdentity() { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
  private set(a: number, b: number, c: number, d: number, e: number, f: number) { this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f; return this; }
  multiplySelf(o: { a: number; b: number; c: number; d: number; e: number; f: number }) {
    return this.set(this.a * o.a + this.c * o.b, this.b * o.a + this.d * o.b, this.a * o.c + this.c * o.d, this.b * o.c + this.d * o.d, this.a * o.e + this.c * o.f + this.e, this.b * o.e + this.d * o.f + this.f);
  }
  preMultiplySelf(o: { a: number; b: number; c: number; d: number; e: number; f: number }) {
    return this.set(o.a * this.a + o.c * this.b, o.b * this.a + o.d * this.b, o.a * this.c + o.c * this.d, o.b * this.c + o.d * this.d, o.a * this.e + o.c * this.f + o.e, o.b * this.e + o.d * this.f + o.f);
  }
  translateSelf(x = 0, y = 0) { return this.multiplySelf(new PlainMatrix([1, 0, 0, 1, x, y])); }
  scaleSelf(sx = 1, sy = sx) { return this.multiplySelf(new PlainMatrix([sx, 0, 0, sy, 0, 0])); }
  invertSelf() {
    const det = this.a * this.d - this.b * this.c;
    if (!det) return this.set(NaN, NaN, NaN, NaN, NaN, NaN);
    return this.set(this.d / det, -this.b / det, -this.c / det, this.a / det, (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det);
  }
  multiply(o: PlainMatrix) { return new PlainMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(o); }
  translate(x = 0, y = 0) { return new PlainMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).translateSelf(x, y); }
  scale(sx = 1, sy = sx) { return new PlainMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).scaleSelf(sx, sy); }
  inverse() { return new PlainMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).invertSelf(); }
  transformPoint(p: { x?: number; y?: number } = {}) { const x = p.x ?? 0, y = p.y ?? 0; return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 }; }
}

async function loadPdfParse(): Promise<typeof import("pdf-parse")> {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") g.DOMMatrix = PlainMatrix;
  if (!g.pdfjsWorker) {
    // Sets globalThis.pdfjsWorker, which pdfjs uses instead of importing its worker by path.
    await import("pdfjs-dist/legacy/build/pdf.worker.mjs").catch(() => undefined);
  }
  return import("pdf-parse");
}

/** Text out of a .pdf, .docx, .txt or .md file's bytes, trimmed; an empty result is a refusal, not "". */
export async function extractDocumentText(data: Buffer | Uint8Array, fileName: string): Promise<ExtractedText> {
  if (data.byteLength > MAX_DOCUMENT_BYTES) return { ok: false, message: "File too large (max 15 MB)." };
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let text = "";
  try {
    if (/\.pdf$/i.test(fileName)) {
      const { PDFParse } = await loadPdfParse();
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try {
        const r = await parser.getText();
        text = r.text ?? "";
      } finally {
        await parser.destroy().catch(() => {});
      }
    } else if (/\.docx$/i.test(fileName)) {
      const mammoth = await import("mammoth");
      text = (await mammoth.extractRawText({ buffer: buf })).value;
    } else if (/\.(txt|md)$/i.test(fileName)) {
      text = buf.toString("utf-8");
    } else {
      return { ok: false, message: "Use a PDF, Word (.docx), or text file." };
    }
  } catch (e) {
    return { ok: false, message: `Couldn't read the file: ${e instanceof Error ? e.message : "unknown error"}` };
  }
  text = text.trim();
  if (!text) return { ok: false, message: "The file has no readable text." };
  return { ok: true, text };
}
