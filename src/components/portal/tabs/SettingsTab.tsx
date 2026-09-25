import Link from "next/link";
import { KeyRound, Palette, UserRound, Users } from "lucide-react";
import { Card, CardTitle, LoadFailed, RowLink } from "@/components/portal/ui";
import { TeamSettings } from "@/components/portal/TeamSettings";
import type { TeamSeat } from "@/lib/portalTeam";

// ---------------------------------------------------------------------------
// SETTINGS & TEAM (CP-06, Sep 24 2026). Who you are on this account, and —
// for someone who may manage it — who else is on it.
//
// The team actions existed since Sep 21 (portalTeamMembers / Invite / Role /
// Revoke) with no screen calling them. This is that screen, and it tells the
// truth about the one thing that is not live yet: while `portal_invites` is
// off, an invitation is SAVED and listed as held, and nothing reaches the
// person. The shared link carries no name, so it never gets a form it cannot
// use — it is told how to sign in instead, or, while email sign-in is off,
// that adding people opens when it is switched on.
// ---------------------------------------------------------------------------

export type SettingsData = {
  who: { name: string | null; email: string; role: "OWNER" | "COLLABORATOR" | "VIEWER" } | null;
  viewerKind: "TOKEN" | "CLIENT" | "STAFF";
  readOnly: boolean;
  programStatus: string;
  canManageTeam: boolean;
  team: { seats: TeamSeat[]; invitationsOn: boolean } | null;
  teamFailed: boolean;
  signInEmailOn: boolean;
  profileHref: string;
};

const ROLE_WORDS: Record<string, string> = {
  OWNER: "Full access — including approving videos",
  COLLABORATOR: "Collaborator — can plan, comment and request changes",
  VIEWER: "View only",
};

export function SettingsTab({ d }: { d: SettingsData }) {
  return (
    <div className="mt-6 space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Settings &amp; team</h1>

      <Card>
        <CardTitle icon={UserRound}>Your account</CardTitle>
        {d.who ? (
          <div className="mt-2 text-sm">
            <div className="font-medium">{d.who.name || d.who.email}</div>
            {d.who.name && <div className="text-xs text-muted">{d.who.email}</div>}
            <div className="mt-1 text-xs text-muted-2">{ROLE_WORDS[d.who.role] ?? d.who.role}</div>
          </div>
        ) : d.viewerKind === "STAFF" ? (
          <p className="mt-2 text-sm text-muted">You&rsquo;re viewing this account on the client&rsquo;s behalf. Anything you change here is recorded as you.</p>
        ) : (
          <p className="mt-2 text-sm text-muted">You&rsquo;re using your program link. It works on any device you open it on.</p>
        )}
      </Card>

      <section id="team" className="scroll-mt-24">
        <Card>
          <CardTitle icon={Users}>Your team</CardTitle>
          {d.team ? (
            <TeamSettings seats={d.team.seats} invitationsOn={d.team.invitationsOn} />
          ) : d.teamFailed ? (
            <div className="mt-2"><LoadFailed what="your team" /></div>
          ) : d.readOnly ? (
            <p className="mt-2 text-sm text-muted">Your program is {d.programStatus === "PAUSED" ? "paused" : "ended"}, so the team can&rsquo;t be changed right now.</p>
          ) : d.viewerKind === "TOKEN" ? (
            d.signInEmailOn ? (
              <div className="mt-2 text-sm">
                <p className="text-muted">To add an assistant or teammate, sign in with your email first. The shared link doesn&rsquo;t carry a name, and every invitation records who sent it.</p>
                <Link href="/portal/login" className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white"><KeyRound className="size-3.5" /> Sign in with email</Link>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">Adding teammates opens when email sign-in is switched on for your account. Until then, text us their name and email and we&rsquo;ll add them for you.</p>
            )
          ) : (
            <p className="mt-2 text-sm text-muted">Only the program owner can add or remove people on this account.</p>
          )}
        </Card>
      </section>

      <RowLink href={d.profileHref} icon={Palette}>My Brand Profile — colors, logo, fonts, links, music</RowLink>
    </div>
  );
}
