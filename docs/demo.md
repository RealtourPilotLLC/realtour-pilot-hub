# The isolated demo: a whole client month, on this Mac only

This runs the real hub on your Mac against a **private, throwaway database**.
It has three pretend clients whose month is already under way. You can click
through everything a client and the office see: setup, strategy, topics,
planning, scheduling, filming handoff, review, revisions, approval, download,
caption and carryover. Nothing you do here reaches production, a real client,
Kyle's phone or any outside service.

## Start and stop

1. **Stop the normal dev server first.** Next.js allows only one dev server per
   project folder, and the demo script refuses to start while the normal one
   is running.
2. Start the demo in one of two ways:
   - In a terminal: `scripts/demo/run-demo-dev.sh`
   - In Claude: start the **demo** preview.
   The first run builds and fills the database, which takes about a minute.
   Later runs reuse that database, so anything you clicked is still there.
3. The script prints every link you need. They are also saved in
   `$TMPDIR/rtp-isolated-demo/links.txt`.
4. **Ctrl-C** stops the hub and the database, and your data is kept. To start
   over from a fresh month, run `scripts/demo/run-demo-dev.sh --reset`. If a
   run was killed without Ctrl-C, clear it with
   `scripts/demo/run-demo-dev.sh --stop`.

The client sign-in links in the printout work **once** and expire **15
minutes** after the database starts. To get a fresh one, open the client's
file, go to **Settings → Portal access** and press **Get sign-in link**.
Alternatively, start the database yourself in its own terminal with
`scripts/demo/run-demo-db.sh` before running `run-demo-dev.sh` (which then
uses it). Typing `signin` in that terminal prints fresh links.

## The three clients

| Client | Shows |
|---|---|
| **Avery Accelerator TEST** | This month in every state. Accelerator: 4 videos, 1 session. |
| **Parker Pro TEST** | A Pro month: 8 videos and two confirmed 4-hour sessions. |
| **Morgan Ended TEST** | An account that has ended. The library stays open. |

Each month was built by the app's own functions (see
`scripts/_fixtures/representativeMonth.ts`). It is not hand-typed into the
database. Last month (August) is finished and delivered. This month
(September) has four chosen topics and one script carried over from August.
It also has four videos, each filmed on one of the chosen topics and named
after it:

- video 1, *Why the first weekend decides your price*, is waiting for the
  client's review
- video 2, *A Saturday morning on Main Street*, was sent back by the client,
  and its round 2 is with the office
- video 3, *What a pre-listing inspection saves you*, is approved
- video 4, *What days on market really tell a buyer*, is delivered

## Walkthrough

Use two browser windows: one for the office (the hub) and one for the client
(the portal). A private window works well for the client.

**0. You (optional).** Open the *Sign in as Jordan* link and use the email and
password shown. The demo hub is open without signing in, but signing in
records your name on what you do.

**1. The office's view of the month.** Open the **Content Program** page
(`/content`). Avery and Parker each have a card showing their month:
Call → Topics → Scripts → Shoot → Delivered, and how many videos have been
delivered. Press **Show ended clients** to bring in Morgan.
*This proves the office sees every client's month in one place, all worked out
the same way.*

**2. The client signs in and sets up.** In the client window, open Avery's
*Sign in as the owner* link. Home shows one **Your next step**, a short list
of what else is waiting, and **Set up your account** (brand colours, logo,
headshot; each item can be skipped).
*This proves a client signs in as a named person and is guided through setup.*

**3. Strategy.** In the portal, go to **My Plan → Strategy**. The strategy
Jordan approved and released is here, with three pillars.
In the office, the client's file has the same strategy under
**Plan → Strategy**.

**4. Topics.** Go to **My Plan → Topic bank**. It holds 30 approved topics
across the pillars. In the office, **Plan → Topics** also shows 2
AI-proposed topics that nobody has reviewed yet.

**5. Planning the month.** Go to **My Plan** (September). There are 4 chosen
topics:
- 2 planned on the strategy call
- 1 fully answered in writing
- 1 still waiting on the client's answers

*"Scripted, not filmed: carried from Aug into Sep"* is the **next-month
carryover**. On Avery's month the four were already chosen when August's
unfilmed script carried in, so it is kept and marked as an extra that waits
its turn (Home says *4 of 4 · +1 waiting*). The client may swap it for one of
the four.

**6. Scripts.** The portal's **My Plan → Scripts** has one script waiting for
the client, which they can approve or ask to change. In the office, the
client file's **Plan → Scripts** shows:
- a draft waiting for Jordan
- a script the client approved
- a client change request, with **Apply with AI**

Press **Apply with AI** and a new version appears. The demo's stand-in AI
wrote it (see *What is real* below).

**7. Scheduling.** Open the portal's **Schedule**. The strategy call was held
a week before filming, and the month's one session shows as held (filmed a
few days ago), with nothing left to book. The line
*Need something in the next 24 hours? Call or text Kyle at (215) 645-4889* is
the contact rule. Open Parker's portal to see the Pro month's **two
confirmed sessions**.

**8. Filming handoff.** In the office, open Avery's file → **Production →
Sessions**. The filming session says the photographer confirmed 4 topics
filmed. Press it to open the **editor's brief** for the job. It shows the
shoot, the deadline, which topic each video is, and every cut sent to review,
each with its state (approved, changes requested, with Jordan).

**9. Internal review.** Open the **Review Room** (`/review`), or the printed
*Review Room: video B, round 2* link. The client's revision note sits above
the player. The office either approves the cut, which sends it to the client,
or sends it back to the editor. After an approval the demo also shows
*"Dropbox copy failed (Dropbox is not connected)"*. That is expected: the
live hub files a copy in Dropbox at this point, and the demo has no Dropbox.
*This proves nothing reaches the client until the office has approved it.*

**10. Client revision.** In the portal's **Content Library**, open video 1,
*Needs your review*. Play it, pause, type a note and press **Save note**,
then press **Send to the editor**. The request goes to the editor's queue and
the Review Room. Video 2, *Changes in progress*, shows what an earlier
request looks like from the client's side.

**11. Approval.** On video 1, press **Approve this version**, then **Yes,
approve**. Only a signed-in owner can do this. The shared link (*Client
portal, the shared link*) can watch but not approve, because an approval
records who gave it.

**12. Download.** Open video 3 (*Approved*) and press **Download v1
(approved)**. The file saves. A video still waiting for review cannot be
downloaded. That is the one download rule, and it is enforced by the server,
not just the button.

**13. Caption.** An approved video has a **Caption & CTA** card, and **Write
one** saves a caption. Open one of August's delivered videos (or video 1 once
you approved it in step 11). **Draft a caption** reports that it is switched
off until launch, which is also true on the live hub today. To see it in the
demo only:
1. Open **Settings** → *Content program automations*.
2. Turn on **Caption assistant**.
3. Press Draft again.

The draft is made from the script the client approved for that video's topic
(the demo's stand-in AI writes the words). Video 3 was approved from a script
that is still with Jordan, so it has no released words to draft from and the
drafter says so. Writing a caption by hand works on any approved video.

**14. An ended account.** Open Morgan's shared link. It reads *Your program
has ended* and everything delivered is still there to watch and download. In
the office, Morgan's file → **Settings** shows the package and the status
controls Kyle uses. Every change is recorded in the history.

## What is real and what is not

**Real:**
- the hub's own code and pages
- its rules: the one download rule, the review windows, month progress,
  sign-in, permissions
- a real Postgres database engine. It runs inside the demo process instead
  of on Neon.

**Not connected:** Aryeo, Dropbox, Stripe, Slack, Gmail/Google, OpenPhone
(Quo), Script Studio, Calendly, QuickBooks and Plaid. The demo database has
no connection to any of them. The demo server also carries a network fence
that blocks every outside call; the demo terminal logs each one it blocks.
No email or text can be sent.

**The AI is a stand-in.** Anything the hub would ask Claude for (a script
rewrite, a caption) is answered on this Mac by a stub. The stub returns
short, fixed filler text in the right shape. Nothing is sent to Anthropic.
The drafts are placeholders, not real writing.

**Every video is the same 3-second clip** of colour bars with a moving band,
generated by the demo. It plays through the hub's real video route, so
playback, the download rule and the file download all behave as they do
live.

**Three things do leave the browser if you press them:**
- the *Book the call* Calendly link
- the *Restart your program* website link
- Kyle's *call / text* links

They open the real page or your phone app. Don't book or text anything from
the demo. The **Continue with Google** button on the sign-in page does not
work here; use the email and password.

## If something looks wrong

- **A page errors after about 5 seconds.** Reload it. The demo database runs
  one query at a time, and a page that waits on a second query while the
  first is still running can time out.
- **The normal dev server misbehaves after a demo** (a "React Client
  Manifest" 500). Run `rm -rf .next/dev` and start it again.
- **"Port 5599 is held by …"** means something else is using the demo's
  port. Run `scripts/demo/run-demo-dev.sh --stop`, or restart the Mac.
- The demo database's log is `$TMPDIR/rtp-isolated-demo.db.log`.
