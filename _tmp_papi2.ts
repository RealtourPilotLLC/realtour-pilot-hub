import { aryeoRequest } from "./src/lib/integrations/aryeo";
async function main() {
  const list = await aryeoRequest<{ data?: { id?: string; title?: string; categories?: unknown }[] }>("/products", { query: { per_page: 5 } });
  const first = list.data?.[0];
  console.log("categories on list row:", JSON.stringify(first?.categories)?.slice(0, 300));
  const one = await aryeoRequest<{ data?: Record<string, unknown> }>(`/products/${first!.id}`);
  console.log("\nsingle-product keys:", Object.keys(one.data ?? {}).join(", "));
  console.log("is_serviceable:", one.data?.is_serviceable);
}
main();
