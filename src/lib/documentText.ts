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

/** Text out of a .pdf, .docx, .txt or .md file's bytes, trimmed; an empty result is a refusal, not "". */
export async function extractDocumentText(data: Buffer | Uint8Array, fileName: string): Promise<ExtractedText> {
  if (data.byteLength > MAX_DOCUMENT_BYTES) return { ok: false, message: "File too large (max 15 MB)." };
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let text = "";
  try {
    if (/\.pdf$/i.test(fileName)) {
      const { PDFParse } = await import("pdf-parse");
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
