// Live one-off (Oct 23 2026): Jordan approved this catch-up reply to Arielle Roemer (threaded, from info@). --apply sends.
import { sendGmailReply } from "@/lib/integrations/google";
const BODY = `Hi Arielle,

Thank you for letting us know, and I'm sorry about the trouble with the link! That's fixed now. I just sent a fresh sign-in link to both your Fox & Roach and Gmail addresses. It's good for 24 hours. After that, just go to hub.realtourpilot.com/portal/login and type either email address, and a new link will arrive within a minute. There's no password to remember.

Here's a quick catch-up on where everything stands:

Your strategy: your content strategy is in the portal under Your Month, in the Strategy tab, for you and the team to reference anytime.

September: your two scripts, "The Team Behind Your Move" and "What It's Like Working With the Arielle Roemer Team," are approved and ready to film. To book your session, add the filming address and pick a time that works. We'll confirm it right away.

October: choose your two video topics and answer a few short questions about each. It takes about ten minutes, and we write your scripts from your answers. Your October filming opens as soon as those are in.

After filming: your finished videos land in the portal, where you can review them, request any changes, and download the final versions.

If anything gives you trouble, just reply here and we'll take care of it. We're excited to get you and the team on camera!

Warmly,
Jordan`;
(async () => {
  if (!process.argv.includes("--apply")) { console.log(BODY); return; }
  console.log(await sendGmailReply({ mailbox: "info@realtourpilot.com", threadId: "1a0d4bd10aee0332", body: BODY, expectedTo: "arielle.roemer@foxroach.com", clientCopy: true }));
})();
