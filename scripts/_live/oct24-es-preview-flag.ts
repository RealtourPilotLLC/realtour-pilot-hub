export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 24 2026). Epidemic Sound refused a preview at 11:21 AM ET
// today (402 "Stream quota exceeded", checked by hand). Records that refusal
// through the shipped helper so the Music card shows its "previews are off"
// note on the next page load instead of after one more failed Play. Writes one
// AppSetting row (epidemic-sound:preview-quota); the next good preview or a
// newly saved key clears it. Dry run by default; --apply writes.
// ---------------------------------------------------------------------------
async function main() {
  const es = await import("../../src/lib/integrations/epidemicSound");
  console.log(`before: ${(await es.esPreviewQuotaHitAt())?.toISOString() ?? "nothing recorded"}`);
  if (!process.argv.includes("--apply")) process.exit(0);
  await es.markEsPreviewQuota();
  console.log(`after: ${(await es.esPreviewQuotaHitAt())?.toISOString()} · paused=${await es.esPreviewsPaused()}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
