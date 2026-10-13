// Oct 13 2026 (Jordan): "Open the raw footage" didn't work — three job folders'
// 02-RAW-Video had been renamed outside the hub ("…_02-RAW-Video", "02-RAW-Video (1)").
// Where the standard folder is MISSING, rename the one stray back (files ride along).
// Where BOTH exist, nothing is moved: the "Open" link already picks whichever holds the files.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct13/rename-stray-raw-video.ts [--apply]
import { prisma } from "@/lib/prisma";
const JOBS = [
  "/AutoHDR/2026/Q4/October/2625 Wassergass Rd (Georgiana Torrella)",
  "/AutoHDR/2026/Q3/September/3826 Fairmount Ave (Stephen Kennedy)",
  "/AutoHDR/2026/Q3/September/2549 Crestline Dr (Bob Kelley)",
];
async function main() {
  const apply = process.argv.includes("--apply");
  const { dropboxListFolder, dropboxMoveFolder } = await import("@/lib/integrations/dropbox");
  const { strayStandardFolder, folderFileCount } = await import("@/lib/dropboxFolders");
  for (const job of JOBS) {
    const names = (await dropboxListFolder(job)).filter((e) => e.tag === "folder").map((e) => e.name);
    const stray = strayStandardFolder(names, "02-RAW-Video");
    const has = names.includes("02-RAW-Video");
    const strayN = stray ? await folderFileCount(`${job}/${stray}`) : null;
    const stdN = has ? await folderFileCount(`${job}/02-RAW-Video`) : null;
    console.log(`${job.split("/").pop()}: standard ${has ? `${stdN} files` : "missing"} · stray ${stray ? `"${stray}" ${strayN} files` : "none"}`);
    if (stray && !has) {
      if (!apply) { console.log("   → would rename back to 02-RAW-Video"); continue; }
      const ok = await dropboxMoveFolder(`${job}/${stray}`, `${job}/02-RAW-Video`);
      console.log(ok ? "   → renamed back to 02-RAW-Video" : "   → refused (conflict)");
      const p = await prisma.project.findFirst({ where: { dropboxFolder: job }, select: { id: true } });
      if (ok && p) await prisma.activity.create({ data: { projectId: p.id, type: "SYSTEM", body: `Dropbox folder "${stray}" renamed back to 02-RAW-Video` } });
    } else if (stray && has) console.log("   → both exist: left as is; the Open link picks the one with files");
  }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
