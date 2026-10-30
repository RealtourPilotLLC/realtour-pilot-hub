import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { ProfileView } from "@/components/profile/ProfileView";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { ROLE_LABEL } from "@/lib/auth/access";
import { teamPhotoSrc } from "@/lib/teamPhoto";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// YOUR PROFILE (Oct 30 2026, Jordan: "give everyone on the platform a profile
// page where they can update their timezone, location, profile picture, and
// phone number and any other preferences"). No page key: every signed-in role
// opens it from their name at the foot of the menu, and it only ever shows and
// writes the viewer's own team card (lib/profile). An owner's "view as" reads
// the person previewed, read only like every page.
// ---------------------------------------------------------------------------

export default async function ProfilePage() {
  const me = await getCurrentUser();
  if (!me && authEnforced()) redirect("/login");
  if (!me) {
    return (
      <div>
        <PageHeader eyebrow="You" title="Your profile" />
        <p className="mx-auto max-w-3xl px-4 py-5 text-sm text-muted sm:px-6">Nobody is signed in on this local copy.</p>
      </div>
    );
  }
  const { myTeamCard } = await import("@/lib/profile");
  const card = await myTeamCard(me).catch(() => null);

  let notify: import("@/lib/notifyPrefDefaults").TeamNotifyRow | null = null;
  let schedule: import("@/lib/notifyPrefDefaults").NotifyScheduleRow | null = null;
  if (card?.active) {
    const [{ teamNotifyRows }, { loadMyNotifySchedule }] = await Promise.all([import("@/lib/notifyPrefs"), import("@/app/settings/actions")]);
    [notify, schedule] = await Promise.all([
      teamNotifyRows().then((rows) => rows.find((r) => r.teamMemberId === card.id) ?? null).catch(() => null),
      me.teamMemberId === card.id ? loadMyNotifySchedule().catch(() => null) : Promise.resolve(null),
    ]);
  }

  return (
    <div>
      <PageHeader eyebrow="You" title="Your profile" subtitle="Your photo, how to reach you, and how the hub notifies you" />
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
        <ProfileView
          account={{ name: card?.name ?? me.name ?? me.email, email: me.email, role: ROLE_LABEL[me.role] ?? me.role, readOnly: me.impersonating }}
          card={card ? {
            id: card.id,
            phone: card.phone ?? "",
            timezone: card.timezone ?? "",
            location: card.location ?? "",
            photoSrc: teamPhotoSrc(card),
            slackLinked: !!card.slackId,
            isEditor: !!card.editorKey,
          } : null}
          notify={notify}
          schedule={schedule}
        />
      </div>
    </div>
  );
}
