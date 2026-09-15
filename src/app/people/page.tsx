import { redirect } from "next/navigation";

// "People" is what the sidebar calls /users, and it is the word Jordan and
// the Slack-ID nudge (notify.ts, Sep 15) use — so the plain URL lands there
// too. Same stub pattern as /team → /users?tab=team.
export default function PeopleRedirect() {
  redirect("/users?tab=team");
}
