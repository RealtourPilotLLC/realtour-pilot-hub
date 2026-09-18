# How Kyle runs delivery, and how a video gets from a booking to a client

Written Sep 18 2026, after the audit work. Everything below is how the hub
behaves now, not how it is meant to behave one day.

---

## Kyle's day

**Open `/ops`.** It is ordered the way the day is, and the top of it is the only
part that is about money already spent.

1. **Ready to send.** The bright card. Every video that is finished, approved
   and has not gone to the client, with the exact file and where it is. Each row
   says which file it is offering and why that one:
   - *the 1080p file* — the Topaz pass ran and this is its output;
   - *the editor's export* — the pass was skipped or failed, and the line
     underneath says why.

   Three things can be done from the row. **Watch it** plays the cut. **Download
   it** hands over the bytes, minting the link at the moment of the press.
   **Mark as sent** records that Kyle uploaded it to Aryeo and delivered the
   listing — it asks twice, because nothing in the hub can clear that stamp.

   If the pass failed, the row also carries **Try the pass again**. That used to
   live on the Connections page next to the API key; it is on the row now,
   because that is where the failure is read. It asks before it fires, because a
   retry is a new charge.

   A row will also say what Aryeo already shows on the listing, in three
   colours: nothing to decide, something up there *could* be this file so play
   it first, or — in red — the client has complained since this file was ready,
   so what is up there may be the very thing they are complaining about.

2. **On your radar.** Strategic risk, and the first thing on it is now a
   **delivery nobody can confirm**. The reconciliation asks Aryeo live — never
   the cached evidence, which goes stale seven days after a delivery — and
   raises a flag when a job is owed or uncertain. It never changes a status,
   never re-sends a file and never contacts anybody. Clearing one is Kyle's or
   Jordan's job, not the hub's.

3. **The pipeline / delivery board.** One row per job, with one blocker each.
   The blocker is the thing to scan: *Waiting on video*, *Changes requested*,
   *Ready for editing*, *Needs QC*, *Delivered* — and now **Waiting on the flow
   and vision for the edit, the wrap-up on the upload page from Harrison
   Wells**, which is a job whose footage is in and whose instructions are not.
   It names the person and carries a chase date.

   If the board itself cannot be read, it says so. It no longer renders a failed
   query as a clean board with nothing past due.

4. **The rest of the day** — QC, open loops, comms, closeout — is unchanged.

---

## A video, end to end

### 1. Booked
Aryeo sends the order. The job gets its deliverables, and every owed video gets
its own row: a sixteen-video branding package is sixteen rows, not the integer
16. Each row can carry its own owner, deadline, current version, review state
and delivery evidence.

### 2. Promised
The job's due date is computed once and **frozen** — `promisedDueAt`. A premium
reel is four business days to the client and three to the internal target,
ending 5pm Eastern. Four business days is a day count, not 96 hours: a Friday
9am shoot is due end of the following Thursday. Changing a default in Settings
from here on cannot move a promise already made.

### 3. Shot and handed off
The photographer shoots, uploads to Dropbox and finishes the wrap-up. **Files in
and instructions ready are two different facts.** A premium or branding job owes
a brief; a plain social reel owes nothing beyond the footage. Until what is owed
arrives, the job's card says what is missing, who has it, and when to chase.

### 4. Edited and submitted
The editor uploads a version from `/edit`. Version numbers are allocated behind a
lock on that one video, so two editors uploading at the same moment cannot both
be "Version 2". An over-spec export is refused with the fix spelled out, and only
an owner or admin can wave one through, with their name on it.

### 5. Reviewed
The cut lands in the Review Room with timestamped notes. Jordan approves it, or
sends it back with notes that become the next round.

A photographer tagged on a cut can open it, watch it and answer — and sees only
the cut and the notes addressed to them. The editor brief, the reel recipe and
the client's own comments are not theirs.

### 6. The 1080p pass
Approval queues the Topaz pass. It reads the file's own header for duration and
frame rate, because a made-up frame count is a made-up price. It checks the
audio first: a track it cannot carry is a silent delivery, so a non-AAC source is
skipped rather than rendered, and a render that comes back silent is never
filed.

Every spend cap is re-checked **after** the job is in the ledger, so two workers
cannot both take the last slot, and an overshoot is handed back for free.

When it finishes, the folder reads:

```
05-Final-Video/
  Personal Branding Reel - Video 1 of 4 - v1 - FINAL (Topaz).mp4   ← send this
  superseded/
    Personal Branding Reel - Video 1 of 4 - v1 (before Topaz).mp4  ← what it replaced
```

**One rule: send the file whose name ends in FINAL.** If the pass was skipped or
failed, the editor's own export is renamed `- FINAL (editor export)`, so that
rule holds however the job ended. The old `- 1080p` marker said nothing — the
editor's export is 1080p too.

A header that cannot be read is retried against a fresh cache key before
anything is concluded, and is retryable rather than terminal. One bad read is
not a broken file.

### 7. Delivered
The video shows on Kyle's Ready-to-send card. He uploads it to Aryeo, delivers
the listing, and presses **Mark as sent**.

**A video in our Dropbox is not a video the client can open.** The status engine
keeps those apart: what the Aryeo listing carries is the only evidence the client
can reach the file; what is in Dropbox Final is produced, not delivered. A job
with work finished and unsent reads REVIEW and says which piece is owed — it
cannot read DELIVERED.

A hand delivery by the office still outranks all of it. Delivery is a human fact.

### 8. Changes
A client asks for something. The ask is kept whole, split into itemised work, and
**each item knows which video it is about**. Fixing video 1 does not close an
untouched request about video 3. One work order per medium — a photo ask never
lands on the video editor's card.

After an internal approval the job is not finished: the corrected file still has
to go back to the client, and it stays on the Ready-to-send card until somebody
says it went.

### 9. Replacing something already sent
An approved video can still be replaced. The wall stays — an approval is a
decision — but it has a door, and the door asks why. The reason goes on the
timeline under the name of whoever opened it, the office is told, and the
approved version keeps its bytes, its round number and its verdict. Nothing about
it reaches the client; sending the replacement is still a separate act.

---

---

## Four journeys, walked on the real data

The Sep 18 review asked for four staff journeys shown end to end, with the
assigned person, the promise, the current version, the next action and the
resulting state on each screen. `scripts/_recon/journeys.ts` walks them through
the shipped engines against production. It is read-only: every call is a query
or a pure function, nothing is written and nobody is contacted. Run it with

```
PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
set -a && source .env; set +a && \
NODE_OPTIONS=--conditions=react-server npx tsx scripts/_recon/journeys.ts
```

What it printed on Sep 18, unedited apart from trimming to width.

### 1 · A standard listing video — 204 Spring Ln

```
headline      Confirmed by count, not by name
ordered       Zillow 3D Tour · Floor Plan · Photos · Social Influencer · Drone Photos
videos        0 of 1 with the client
promise       2026-09-12 (frozen) — PAST IT
client asked  2026-09-17 — "Mike Added on a standard tour reel! Please edit as soon as possible."
whose move    John Mark — Edit and hand it in
per video     1:not_started
```

Everything the reviewer asked for is in those seven lines, and the job is a good
one to start with because it is the awkward case. There IS a video on the Aryeo
listing. Nothing ties it to the video we owe, our own row says nothing has been
started, and the date the client was given passed six days ago. Three engines
that used to give three answers here now give one: the headline refuses to call
an anonymous listing entry a delivery, the promise is reported past whatever the
counts say, and the next action names John Mark.

### 2 · A multi-video monthly batch — 5642 Limeport Rd

```
headline      Awaiting production
ordered       Video Starter - 2HR Session ×2
videos        0 of 4 with the client · furthest: v1 — Personal Branding Reel — Video 1 of 4
promise       2026-09-25 (frozen)
blocker       Waiting on the flow and vision for the edit, how many videos were filmed,
              the wrap-up on the upload page from James Livingston.
whose move    Kyle — Send 1 finished video and press Mark as sent
per video     1:approved/v1  2:not_started  3:not_started  4:not_started
```

Two things a row count cannot say. The order row says two sessions; the job owes
FOUR videos and each one has its own line. And two people are holding it at
once — James owes the wrap-up before videos 2–4 can be cut, and Kyle owes a send
on video 1, which is finished now. Before this work the job was one status and
one editor name.

### 3 · A delivered video that needs replacing

```
no job in production is in this state today
```

Said plainly rather than demonstrated on a fixture. The state — an approved
version the client has not been sent, on a slot an earlier version WAS sent from
— is exercised in `scripts/_drill/output-lifecycle.ts` against an isolated
database, 41 assertions with the pre-change module imported beside the new one
at every step. It is also one of the five rows the exceptions card watches for,
so the day it happens it appears on Kyle's board by itself.

### 4 · An unresolved client request spanning the message window

```
3 open obligations
(267) 900-8794    1d   inside the window   New caller — call back
   "Missed call — call them back"
Mike Flatley      0d   inside the window   Clarify two unrecognized AmEx charges
   "I personally only need Sharra's. This was a little messy since Mike placed the video order…"
Andrea Neff       0d   inside the window   Quote MLS-compliant video version for 632 Greenridge
   "Hi Jordan! I ABSOLUTELY L.O.V.E. what you guys did with the video, but had no idea the MLS…"
```

All three are inside the seven-day window today, so the ledger is currently
preventive rather than recovering anything — which is worth saying, because a
fix that changes no rows today is easy to overstate. What it changes is that
none of them can age out, and that an unsuccessful callback no longer counts as
an answer.

### And the board Kyle actually opens

```
5 exceptions
[high]   aging-review   August 2026 Social Content   James Livingston   Watch it and approve or send it back
[high]   aging-review   38 E Gay St                  James Livingston   Watch it and approve or send it back
[high]   aging-review   August 2026 Social Content   James Livingston   Watch it and approve or send it back
[high]   aging-review   August 2026 Social Content   James Livingston   Watch it and approve or send it back
[medium] unassigned     TEST Cara listing job        Nobody yet         Pick an editor in the Editing Room
```

Four cuts have been waiting between sixteen and twenty-two days for somebody to
say yes or no. That is the single most useful thing any of this work surfaced,
and nothing was told to look for it — it fell out of asking every row who owns
it. The name beside them comes from the creative-manager flag rather than a
decision, and the card says so; naming the creative approver in Settings is on
Jordan's list.

## What is switched off

Client launch. No invitations, reminders, publishing or new outbound automation
is enabled. The client portal has never been opened to a client, and none of this
work opens it.

## What is waiting on Jordan

- **A private Blob store.** All 14 review-cut objects are world-readable today.
  The exact steps are in `docs/REVIEW-CUT-STORE-HANDOVER.md`; the store's access
  level is fixed at creation, so only a new store can fix it.
- **An on-call person** for urgent alerts outside Mon–Fri 9–6. Until somebody is
  named, urgent alerts page exactly as they do today.
- **A creative approver.** Any owner or admin can already approve a cut — the
  capability was never the gap. Naming who is *expected* to is what stops every
  waiting cut being implicitly Jordan's. Settings → Review Room.
- **A scratch Neon branch** to rehearse a full database restore against. It is
  the only way to test whole-hub recovery without touching production, and
  creating one is an account action.
- **45 Heron Hill Dr**: 60 finished photos in our Final folder for an order with
  no photography product, and a listing with no images. Either it was done and
  never billed, or those files belong to another job.
- **893 S Matlack St**: sixteen videos ordered, one approved, six finished in
  Dropbox, listing empty.
