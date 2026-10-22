// Read-only: when did the Oct 21 raws for 615 Cliff Ln reach Dropbox?
import { dropboxListFolder } from "@/lib/integrations/dropbox";
(async () => {
  const entries = (await dropboxListFolder("/AutoHDR/2026/Q4/October/615 Cliff Ln (Alex  Ercole Stackhouse)/01-RAW-Photos", { recursive: true })) as Array<{ ".tag"?: string; tag?: string; name: string; server_modified?: string; serverModified?: string }>;
  const t = entries.map((e) => e.server_modified ?? e.serverModified).filter(Boolean).sort() as string[];
  const recent = t.filter((x) => x >= "2026-10-21");
  console.log("files", t.length, "since Oct 21:", recent.length, "first", recent[0], "last", recent.at(-1));
})();
