// Read-only: the Gmail thread ids of two messages in info@ (Mike's "Follow up", Arielle's reply).
import { ownerGoogleToken } from "@/lib/integrations/google";
(async () => {
  const token = await ownerGoogleToken();
  if (!token) throw new Error("no owner Google token");
  for (const id of ["1a168c9eee905901", "1a1692d79c4d0bc8"]) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject`, { headers: { Authorization: `Bearer ${token}` } });
    const j = (await r.json()) as { threadId?: string; payload?: { headers?: { name: string; value: string }[] } };
    console.log(id, "thread", j.threadId, JSON.stringify(j.payload?.headers ?? []));
  }
})();
