// @drill-run: conditions=none
// Deterministic transport outcomes after a file has landed, no DB/providers.
import { cutUploadFinishReceipt } from "../../src/lib/cutUploadFinishReceipt";
import { makeChecker } from "./_harness";
async function main() {
  const c = makeChecker();
  const saved = { ok: true, message: "Version 1 is in review" };
  c.ok("committed finish keeps its actual receipt", await cutUploadFinishReceipt(async () => saved) === saved);
  const refused = { ok: false, message: "This file is not in the hub store" };
  c.ok("known refusal remains a refusal", await cutUploadFinishReceipt(async () => refused) === refused);
  const held = { ok: false, held: true, message: "Finish the check" };
  c.ok("file-bound check hold remains recoverable", await cutUploadFinishReceipt(async () => held) === held);
  const lost = await cutUploadFinishReceipt(async () => { throw new Error("lost response after commit"); });
  c.ok("lost response preserves bytes and requests a fresh recorded read", !lost.ok && lost.held === true && lost.message.includes("kept"));
  let late!: (value: typeof saved) => void;
  const pending = new Promise<typeof saved>(resolve => { late = resolve; });
  const bounded = await cutUploadFinishReceipt(() => pending, 5);
  c.ok("never-returning finish stops its spinner without abandoning bytes", !bounded.ok && bounded.held === true);
  late(saved);
  c.ok("late commit is not cancelled by the UI timeout", await pending === saved);
  c.summary();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
