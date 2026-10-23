// Read-only: every file under 615 Cliff Ln's Dropbox folder changed today, by subfolder.
import { dropboxListFolder } from "@/lib/integrations/dropbox";
(async () => {
  const root = "/AutoHDR/2026/Q4/October/615 Cliff Ln (Alex  Ercole Stackhouse)";
  const all = (await dropboxListFolder(root, { recursive: true })) as Array<{ ".tag"?: string; name: string; path_display?: string; pathDisplay?: string; server_modified?: string }>;
  const today = all.filter((e) => (e.server_modified ?? "") >= "2026-10-23T16:00");
  const by = new Map<string, number>();
  for (const e of today) { const pth = (e.path_display ?? e.pathDisplay ?? "").replace(root, "").split("/").slice(0, -1).join("/") || "/"; by.set(pth, (by.get(pth) ?? 0) + 1); }
  console.log("files today:", today.length, JSON.stringify([...by]));
  const t = today.map((e) => e.server_modified!).sort();
  console.log("first", t[0], "last", t.at(-1));
})();
