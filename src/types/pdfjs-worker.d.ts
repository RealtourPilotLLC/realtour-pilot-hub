// pdfjs ships no types for its worker module; documentText.ts only imports it
// for its side effect (it sets globalThis.pdfjsWorker). See the note there.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
