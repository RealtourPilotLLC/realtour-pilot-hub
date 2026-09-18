// R09: a video "released" to a portal nobody can open is not delivered.
import { readyToSend } from "@/lib/readyToSend";
async function main() {
  const board = await readyToSend();
  console.log(`Ready to send: ${board.ready.length} · still rendering: ${board.rendering.length}`);
  for (const v of board.ready) {
    console.log(`  ${v.street.slice(0, 34).padEnd(34)} ${v.cutLabel.slice(0, 30).padEnd(30)} v${v.round}  [${v.file.source}]`);
  }
  const sarina = board.ready.find((v) => v.clientName?.includes("Sarina") || v.cutLabel.includes("Video 1 of 4"));
  console.log(`\nSarina Spinelli's video is on Kyle's card: ${sarina ? "YES" : "no"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
