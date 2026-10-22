export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026). Jordan: "Next week, Harrison is taking off for a
// week." Mon Oct 26 to Fri Oct 30 2026 (5 service days) on Harrison's PTO bank,
// through the tracker's own compare-and-set (lib/pto updatePto), with the same
// entry shape the owner's form writes. The sick day from the week before waits
// for its date from Jordan. Dry run by default; --apply writes.
// ---------------------------------------------------------------------------
async function main() {
  const apply = process.argv.includes("--apply");
  const pto = await import("../../src/lib/pto");
  const roster = await pto.ptoRoster();
  const h = roster.find((m) => /^harrison/i.test(m.name));
  if (!h) throw new Error(`Harrison is not on the PTO roster: ${roster.map((m) => m.name).join(", ")}`);
  const startKey = "2026-10-26", endKey = "2026-10-30";
  const year = pto.agreementYearFor(startKey);
  const { days, holidays } = pto.serviceDaysIn(startKey, endKey);
  const before = await pto.ptoBalance(h.id, h.name, year.key);
  console.log(`${h.name} | ${year.label} | ${pto.rangeLabel(startKey, endKey)} = ${days.length} service days, holidays skipped: ${holidays.map((x) => x.name).join(", ") || "none"} | balance now ${before.remaining} of ${before.bank}`);
  if (!apply) { console.log("dry run: nothing written (add --apply)"); return; }
  const by = "info@realtourpilot.com (entered by Claude from Jordan's note)";
  const r = await pto.updatePto(h.id, year.key, by, (entries) => {
    const overlap = entries.find((e) => e.startKey <= endKey && e.endKey >= startKey);
    if (overlap) return `Already on file: ${pto.rangeLabel(overlap.startKey, overlap.endKey)}`;
    entries.push({ id: crypto.randomUUID(), startKey, endKey, type: "vacation" as never, fraction: 1, note: "Week off (Jordan, Oct 22 2026)", by, at: new Date().toISOString() });
    return { entries, what: `Added ${pto.rangeLabel(startKey, endKey)} (vacation)` };
  });
  const after = await pto.ptoBalance(h.id, h.name, year.key);
  console.log(r.ok ? `written | balance ${after.remaining} of ${after.bank}` : `refused: ${r.message}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
