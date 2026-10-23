// Live one-off (Oct 23 2026): Jordan approved this follow-up to Bernadette Rabel after the Oct 21 call ("We're good lets send that"). From info@. --apply sends.
import { sendGmailNew } from "@/lib/integrations/google";
const SUBJECT = "Ready for Monday's call";
const BODY = `Hi Bernadette,

Great talking with you on Wednesday! I'm excited about where we're taking your content: more of your personality, more humor and more of the Lehigh Valley, with the same goals behind it.

Here's where things stand before Monday:

The two skits: I'm finishing the scripts for your morning animal routine (with your husband's big reveal) and "Real estate agents are scumbags." They'll be in your portal before our call.

Your topic bank: I added a Skits section with new ideas, plus lifestyle and market topics for the other three videos. Take a look and mark any favorites.

A few things on your side, if you have a minute:
- Check that your husband is in for the skits
- Add any ideas of your own to the topic bank
- Fill in your brand profile (colors, fonts, logo, music and editing preferences)
- Review the videos waiting for your approval, and keep posting one a week

The branding photographer I mentioned is Kelsey Renee: https://kelseyreneephotography.com/

Your strategy is in the portal too, any time you want to look back at it.

Talk Monday at 3:30!

Jordan`;
(async () => {
  if (!process.argv.includes("--apply")) { console.log(`To: brabel@therabelgroup.com\nSubject: ${SUBJECT}\n\n${BODY}`); return; }
  console.log(JSON.stringify(await sendGmailNew({ mailbox: "info@realtourpilot.com", to: "brabel@therabelgroup.com", subject: SUBJECT, body: BODY, strict: true })));
})();
