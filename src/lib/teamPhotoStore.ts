import "server-only";
import { prisma } from "@/lib/prisma";
import { TEAM_PHOTO_MAX_BYTES, TEAM_PHOTO_SIDE } from "@/lib/teamPhoto";

// The server half of lib/teamPhoto: whatever picture someone chose becomes one
// small square JPEG (turned upright from the camera's tag, centre-cropped,
// 256 px), so a 12 MP phone photo never reaches the database and every avatar
// loads the same few kilobytes.

export async function storeTeamPhoto(teamMemberId: string, input: Uint8Array): Promise<Date> {
  if (input.byteLength === 0) throw new Error("That file is empty.");
  if (input.byteLength > TEAM_PHOTO_MAX_BYTES) throw new Error("That picture is too large. Pick one under 4 MB.");
  const sharp = (await import("sharp")).default;
  let jpeg: Buffer;
  try {
    jpeg = await sharp(input, { limitInputPixels: 60_000_000 })
      .rotate()
      .resize(TEAM_PHOTO_SIDE, TEAM_PHOTO_SIDE, { fit: "cover", position: "attention" })
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new Error("That file couldn't be read as a picture. Try a JPG or PNG.");
  }
  const at = new Date();
  const bytes = new Uint8Array(jpeg);
  await prisma.$transaction([
    prisma.teamPhoto.upsert({
      where: { teamMemberId },
      create: { teamMemberId, bytes, contentType: "image/jpeg" },
      update: { bytes, contentType: "image/jpeg" },
    }),
    prisma.teamMember.update({ where: { id: teamMemberId }, data: { photoAt: at } }),
  ]);
  return at;
}

export async function clearTeamPhoto(teamMemberId: string): Promise<void> {
  await prisma.$transaction([
    prisma.teamPhoto.deleteMany({ where: { teamMemberId } }),
    prisma.teamMember.update({ where: { id: teamMemberId }, data: { photoAt: null } }),
  ]);
}
