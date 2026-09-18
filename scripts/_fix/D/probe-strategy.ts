// READ-ONLY probe. The same money clamp runs over RELEASED strategy sections
// in portal.portalStrategy. Not one of the three confirmed defects — measured
// here so the number can be reported rather than guessed at.
import { prisma } from "../../../src/lib/prisma";
import { stripMoneySentences } from "../../../src/lib/text";
import { parseStoredSections } from "../../../src/lib/contentStrategy";

const INTERNAL_HEADING = /framework|caption|production|internal/i;

async function main() {
  const released = await prisma.contentStrategyVersion.findMany({
    where: { releasedAt: { not: null }, status: { in: ["APPROVED", "SUPERSEDED", "SHARED"] } },
    select: { id: true, enrollmentId: true, versionNo: true, sectionsJson: true },
  });
  let sections = 0, changed = 0, emptied = 0, charsBefore = 0, charsAfter = 0;
  const examples: string[] = [];
  for (const v of released) {
    const stored = parseStoredSections(v.sectionsJson);
    for (const s of (stored?.sections ?? []).filter((x) => !INTERNAL_HEADING.test(x.heading))) {
      sections++;
      const after = stripMoneySentences(s.text);
      charsBefore += s.text.length; charsAfter += after.length;
      if (after !== s.text) {
        changed++;
        if (!after.trim()) emptied++;
        if (examples.length < 5) examples.push(`  · v${v.versionNo} "${s.heading}" ${s.text.length}->${after.length} chars${after.trim() ? "" : " (SECTION DISAPPEARS)"}`);
      }
    }
  }
  console.log(`RELEASED strategy versions: ${released.length}; client-facing sections: ${sections}`);
  console.log(`  sections the money clamp changes: ${changed}; sections it empties (dropped from the page): ${emptied}`);
  console.log(`  characters ${charsBefore} -> ${charsAfter} (${charsBefore - charsAfter} removed)`);
  console.log(examples.join("\n"));
}
main().then(() => prisma.$disconnect());
