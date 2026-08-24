import { getSecret } from "./src/lib/integrations/connections";

async function get(path: string, key: string) {
  const res = await fetch(`https://api.calendly.com${path}`, {
    headers: { Authorization: `Bearer ${key}` }, cache: "no-store",
  });
  const text = await res.text();
  let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, raw: text };
}

async function main() {
  const key = (await getSecret("calendly"))!;
  // Who am I (need user uri for possible filters)
  const me = await get("/users/me", key);
  const userUri = (me.json as { resource?: { uri?: string; current_organization?: string } }).resource;
  console.log("user:", userUri?.uri?.slice(-12), "org:", userUri?.current_organization?.slice(-12));

  // List recaps — try plain, then with filters
  for (const q of ["", `?user=${encodeURIComponent(userUri?.uri ?? "")}`, `?organization=${encodeURIComponent(userUri?.current_organization ?? "")}`]) {
    const r = await get(`/meeting_recaps${q}`, key);
    console.log(`\nGET /meeting_recaps${q.slice(0, 30)}… → ${r.status}`);
    if (r.status === 200) {
      const j = r.json as { collection?: Record<string, unknown>[] };
      console.log("  count:", j.collection?.length);
      if (j.collection?.[0]) console.log("  first recap keys:", Object.keys(j.collection[0]).join(", "));
      if (j.collection?.[0]) console.log("  first recap:", JSON.stringify(j.collection[0]).slice(0, 600));
      break;
    } else {
      console.log("  body:", r.raw.slice(0, 200));
    }
  }
}
main().finally(() => process.exit(0));
