// Read-only: folders under /AutoHDR/2026/Q4/October that received files after 4 PM ET today.
import { dropboxListFolder } from "@/lib/integrations/dropbox";
(async () => {
  const root = "/AutoHDR/2026/Q4/October";
  const all = (await dropboxListFolder(root, { recursive: true })) as Array<{ name: string; path_display?: string; server_modified?: string }>;
  const today = all.filter((e) => ((e as any).server_modified ?? (e as any).serverModified ?? "") >= "2026-10-23T20:00");
  const by = new Map<string, { n: number; last: string }>();
  for (const e of today) { const k = ((e as any).path_display ?? (e as any).pathDisplay ?? "").replace(root, "").split("/").slice(0, 3).join("/"); const v = by.get(k) ?? { n: 0, last: "" }; v.n++; const sm = (e as any).server_modified ?? (e as any).serverModified; if (sm > v.last) v.last = sm; by.set(k, v); }
  for (const [k, v] of by) console.log(v.n, v.last, k);
  console.log("total", today.length);
})();
