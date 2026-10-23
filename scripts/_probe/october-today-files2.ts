// Read-only: today's (after 4 PM ET) files under October, grouped by parent folder.
import { dropboxListFolder } from "@/lib/integrations/dropbox";
(async () => {
  const root = "/AutoHDR/2026/Q4/October";
  const all = (await dropboxListFolder(root, { recursive: true })) as Array<Record<string, unknown>>;
  const today = all.filter((e) => String(e.server_modified ?? e.serverModified ?? "") >= "2026-10-23T20:00");
  console.log("keys", Object.keys(today[0] ?? {}).join(","));
  const by = new Map<string, number>();
  for (const e of today) { const pth = String(e.path_display ?? e.pathDisplay ?? e.path_lower ?? e.pathLower ?? e.path ?? ""); const k = pth.replace(/^.*\/october\//i, "").split("/").slice(0, 2).join("/"); by.set(k, (by.get(k) ?? 0) + 1); }
  for (const [k, n] of by) console.log(n, k);
})();
