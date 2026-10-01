/** Keep Home's explicit test scope only on destinations that already support it.
 * Exact project/cut routes and Finance retain their contracts. */
export function homeRecordHref(href: string, includeTest: boolean): string {
  if (!includeTest || !href.startsWith("/") || href.startsWith("//")) return href;
  const url = new URL(href, "http://home.invalid");
  const supported = ["/", "/tasks", "/review", "/content", "/pipeline", "/editing", "/schedule"].includes(url.pathname)
    || (url.pathname === "/communications" && ["email", "outbox"].includes(url.searchParams.get("tab") ?? ""));
  if (!supported) return href;
  url.searchParams.set("test", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}
