// READ-ONLY. "No public store URL appears in any client payload" is a claim
// about DATA as much as about code: a row whose assetUrl was written before
// the stream route existed would ship the object's address into the page's
// HTML no matter how careful reviewRoom.ts is. This asks the database.
import { prisma } from "../../../src/lib/prisma";

const HOST = "blob.vercel-storage.com";

async function main() {
  const assetUrls = await prisma.reviewSubmission.count({ where: { assetUrl: { contains: HOST } } });
  const finalPaths = await prisma.reviewSubmission.count({ where: { finalPath: { contains: HOST } } });
  const assetPaths = await prisma.reviewSubmission.count({ where: { assetPath: { contains: HOST } } });
  console.log("ReviewSubmission.assetUrl holding a store URL:", assetUrls, "(assetUrl is serialised into every review payload)");
  console.log("ReviewSubmission.finalPath holding a store URL:", finalPaths);
  console.log("ReviewSubmission.assetPath holding a store URL:", assetPaths);

  // MediaNote keys on the submission's assetUrl string, so a note written
  // while a cut still redirected to the store would have frozen the object's
  // address into a row nothing rewrites.
  const notes = await prisma.mediaNote.count({ where: { assetUrl: { contains: HOST } } });
  console.log("MediaNote.assetUrl holding a store URL:", notes);

  const msgs = await prisma.projectMessage.count({ where: { body: { contains: HOST } } });
  console.log("ProjectMessage bodies mentioning a store URL:", msgs);

  const sample = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null } },
    select: { id: true, assetUrl: true },
    take: 3,
  });
  console.log("sample assetUrl values for hub-uploaded cuts:", sample.map((s) => s.assetUrl));
}

main().finally(() => prisma.$disconnect());
