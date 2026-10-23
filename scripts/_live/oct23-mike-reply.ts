// Live one-off (Oct 23 2026): Jordan approved this reply to Mike Ciunci's "Follow up" email. --apply sends (threaded, from info@).
import { sendGmailReply } from "@/lib/integrations/google";
const BODY = `Hey Mike, no apology needed, ask away anytime!

The portal: go to hub.realtourpilot.com/portal/login and type mikeciunci@kw.com. You'll get an email with a sign-in link, so there's no password to remember. I'd bookmark that page. You're already set up, since you signed in yesterday.

Notifications: yes! You'll get an email whenever a new video or an edit is ready for you to review in the portal, plus a reminder when it's time to book your next session.

Your reel edit: it didn't come through on our end. The best way to send changes is right in the portal, and they go straight to our editing team:
1. Open Content Library and open the video.
2. Pause where you want the change, type your note and press Send note. Add as many notes as you like.
3. When you're done, press Request changes, and it goes right to the editor.

November: you can book your November session right in the portal now, or send me two dates and times and I'll lock one in.

Thank you for the prayers, brother. It means a lot. Talk soon!

Jordan`;
(async () => {
  if (!process.argv.includes("--apply")) { console.log(BODY); return; }
  console.log(await sendGmailReply({ mailbox: "info@realtourpilot.com", threadId: "1a168c9eee905901", body: BODY, expectedTo: "mikeciunci@kw.com", clientCopy: true }));
})();
