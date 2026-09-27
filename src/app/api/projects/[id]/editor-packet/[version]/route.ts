import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import {
  DISPATCH_CHANNEL_LABEL,
  buildEditorPacket,
  buildEditorPacketPdf,
  packetSignature,
  storedPacketIntact,
  type DispatchChannel,
  type PacketGap,
  type PacketManifest,
} from "@/lib/editorPacket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// THE OUTSIDE AGENCY'S PACKET (unified handoff §7.7 / A33, Sep 25 2026).
//
//   /api/projects/<id>/editor-packet/<n>        — the packet as it was SENT as
//                                                 version n (frozen, never rebuilt)
//   /api/projects/<id>/editor-packet/preview    — the packet as it would go out now
//   ?format=json                                — the manifest + fingerprint + signature
//
// Staff only (owner/admin — the office is who sends it): the packet carries
// the client's name, the job's instructions and its folders. A frozen version
// is served ONLY if its stored manifest still hashes to the fingerprint
// recorded when it was sent — a copy that no longer matches is refused rather
// than handed out as the packet we sent. The signature (HMAC with the app's
// secret) lets a downloaded copy be checked against the hub later. Nothing
// here sends anything to anyone.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; version: string }> }) {
  const { id, version } = await params;
  try {
    await requireAdmin();
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  const asJson = req.nextUrl.searchParams.get("format") === "json";

  let manifest: PacketManifest;
  let hash: string;
  let missing: PacketGap[];
  let ver: number | null = null;
  let dispatch: { recipient: string; channelLabel: string; dispatchedAtISO: string; dispatchedBy: string; acknowledgedAtISO: string | null; acknowledgedBy: string | null; ackSource: string | null; superseded: boolean } | null = null;

  if (version === "preview") {
    const packet = await buildEditorPacket(id);
    if (!packet) return new Response("Not found", { status: 404 });
    manifest = packet.manifest;
    hash = packet.hash;
    missing = packet.missing;
  } else {
    const n = /^\d{1,6}$/.test(version) ? Number(version) : NaN;
    if (!Number.isInteger(n) || n < 1) return new Response("Not found", { status: 404 });
    const row = await prisma.editorDispatch.findUnique({ where: { projectId_packetVersion: { projectId: id, packetVersion: n } } });
    if (!row) return new Response("Not found", { status: 404 });
    if (!storedPacketIntact(row)) {
      return new Response("This packet's stored copy no longer matches the fingerprint recorded when it was sent, so it is not served.", { status: 409 });
    }
    try {
      manifest = JSON.parse(row.manifestJson) as PacketManifest;
      missing = row.missingJson ? (JSON.parse(row.missingJson) as PacketGap[]) : [];
    } catch {
      return new Response("This packet's stored copy cannot be read.", { status: 409 });
    }
    hash = row.packetHash;
    ver = row.packetVersion;
    dispatch = {
      recipient: row.recipient,
      channelLabel: DISPATCH_CHANNEL_LABEL[row.channel as DispatchChannel] ?? row.channel,
      dispatchedAtISO: row.dispatchedAt.toISOString(),
      dispatchedBy: row.dispatchedBy,
      acknowledgedAtISO: row.acknowledgedAt?.toISOString() ?? null,
      acknowledgedBy: row.acknowledgedBy,
      ackSource: row.ackSource,
      superseded: !!row.supersededById,
    };
  }
  const signature = packetSignature(id, ver ?? "preview", hash);
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Packet-Version": ver ? String(ver) : "preview",
    "X-Packet-Hash": hash,
    "X-Packet-Signature": signature ?? "unsigned",
  };

  if (asJson) {
    return Response.json({ projectId: id, version: ver ?? "preview", packetHash: hash, signature, dispatch, missing, manifest }, { headers });
  }
  const bytes = await buildEditorPacketPdf(manifest, { version: ver, hash, signature, missing, dispatch });
  const street = (manifest.project.street || "job").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "job";
  return new Response(new Uint8Array(bytes), {
    headers: {
      ...headers,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="packet-${street}-${ver ? `v${ver}` : "preview"}.pdf"`,
    },
  });
}
