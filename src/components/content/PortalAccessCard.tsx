import { KeyRound } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { portalAccessSummary } from "@/lib/portalAccess";
import { PortalAccessControls } from "@/components/portal/staff/PortalAccessControls";

// ---------------------------------------------------------------------------
// "Portal access" — the owner's card on /content/<id> → Their portal (spec
// §2). Link status (issued / expires / rotated) with Rotate + Expire, the
// people with a seat (invite, role, revoke), "Get sign-in link" for the
// owner's own testing, and "Last opened" from PortalVisit. A SERVER component
// so the mount is one line with no data plumbing:
//     {ownerEyes && <PortalAccessCard enrollmentId={id} />}
// The interactive part lives in components/portal/staff (the portal's own
// tree) because this file is the only one under components/content the
// portal wave owns.
//
// It carries its OWN gate rather than trusting the mount site's `ownerEyes`:
// the card hands over the client's raw portal link and every seat's email, so
// a mis-mount on a page an ADMIN or EDITOR can open must render nothing
// (review, Sep 17). The EFFECTIVE role is checked — an owner previewing as an
// editor sees what the editor sees. With no session at all it renders only
// where the hub's guards are also open (local dev, AUTH_ENFORCE unset).
// ---------------------------------------------------------------------------
export async function PortalAccessCard({ enrollmentId }: { enrollmentId: string }) {
  const u = await getCurrentUser();
  const ownerEyes = u ? u.role === "OWNER" : !authEnforced();
  if (!ownerEyes) return null;
  const s = await portalAccessSummary(enrollmentId);
  if (!s) return null;
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return (
    <Section icon={KeyRound} title="Portal access" count={s.people.filter((p) => !p.revokedAt).length || null}>
      <PortalAccessControls
        enrollmentId={s.enrollmentId}
        clientName={s.clientName}
        isTestClient={s.isTestClient}
        status={s.status}
        link={{ issued: s.link.issued, url: s.link.url, issuedAtISO: iso(s.link.issuedAt), expiresAtISO: iso(s.link.expiresAt), rotatedAtISO: iso(s.link.rotatedAt), expired: s.link.expired }}
        accessRevokedAtISO={iso(s.accessRevokedAt)}
        people={s.people.map((p) => ({ ...p, invitedAtISO: p.invitedAt.toISOString(), acceptedAtISO: iso(p.acceptedAt), revokedAtISO: iso(p.revokedAt), lastLoginAtISO: iso(p.lastLoginAt) }))}
        lastOpened={s.lastOpened ? { atISO: s.lastOpened.at.toISOString(), via: s.lastOpened.via, who: s.lastOpened.who } : null}
        visits={s.visits}
        switches={s.switches}
      />
    </Section>
  );
}
