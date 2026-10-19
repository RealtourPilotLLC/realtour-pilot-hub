/** Keep Home's explicit test scope only on destinations that already support it.
 * Exact project/cut routes and Finance retain their contracts. */
export function homeRecordHref(href: string, includeTest: boolean): string {
  if (!includeTest || !href.startsWith("/") || href.startsWith("//")) return href;
  const url = new URL(href, "http://home.invalid");
  // The dashboard's doors (Oct 19 2026, night): the Shoots board (/jobs),
  // Kyle's list (/ops/checklist), Messages and the retired pages' doors
  // ("/ops", "/ops/old" and the like) read ?test=1 the same way Home does.
  const supported = ["/", "/tasks", "/review", "/content", "/pipeline", "/editing", "/schedule", "/jobs", "/ops", "/ops/checklist", "/ops/old", "/ops/messages"].includes(url.pathname)
    // Messages reads it on Waiting on us (no tab), Email and Outbox; a
    // delivery-text check (?incident=) opens the live list, which does not.
    || (url.pathname === "/communications" && ["", "waiting", "email", "outbox"].includes(url.searchParams.get("tab") ?? "") && !url.searchParams.has("incident"));
  if (!supported) return href;
  url.searchParams.set("test", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}
