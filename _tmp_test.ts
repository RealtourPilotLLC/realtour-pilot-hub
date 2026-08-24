import { prisma } from "./src/lib/prisma";

async function main() {
  // 1) remove my UI-test topic (my invention, not Jordan's)
  const del = await prisma.contentTopic.deleteMany({ where: { title: { contains: "September beat the spring market" } } });
  console.log("test topic removed:", del.count);

  // 2) exercise the backfill extraction path (file→text→AI split→month guess)
  const { previewScriptBackfill } = await import("./src/app/content/actions");
  const doc = `Marcee McMullen — June Content Scripts

Script 1: The biggest pricing mistake I see in West Chester
HOOK: Your house isn't overpriced for the market. It's overpriced for the first ten days.
The first ten days decide everything — that's when the algorithm and the buyers are watching.
If we miss that window, we're chasing the market down instead of leading it.
So before we list, we agree on the ten-day plan together.

Script 2: Why I tell some sellers NOT to renovate
HOOK: I just told a seller to keep her 1987 kitchen. Here's why.
Buyers in this price range are renovating anyway — they want the discount, not your new counters.
Spend the money on paint and light instead. Same offer, ten grand cheaper to get there.`;
  const fd = new FormData();
  fd.append("file", new File([doc], "marcee-june-scripts.txt", { type: "text/plain" }));
  const p = await previewScriptBackfill(fd);
  console.log("\npreview:", JSON.stringify({ ok: p.ok, message: p.message, monthGuess: p.monthGuess, titles: p.scripts?.map(s => s.title) }, null, 1));
}
main().finally(() => prisma.$disconnect());
