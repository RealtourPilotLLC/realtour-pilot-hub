# Instagram caption rules (monthly program videos)

Oct 23 2026. Jordan: "Caption writing should follow Instagram / meta's rules
for writing captions that drive the most engagement."

These are the rules the automatic caption drafter follows. Every Instagram
rule below comes from Instagram's or Meta's own words (or a trade report of
an Instagram post, marked as such), with the source and its date. The house
rules come after them. The prompt is `src/lib/contentPolicy/captionRules.ts`
(`CAPTION_SYSTEM`); the code checks are `finishCaption` and `checkCaption` in
the same file.

## Instagram and Meta rules

| # | Rule | Source (date) | Checked in code? |
|---|------|---------------|------------------|
| IG1 | **At most 5 hashtags.** Instagram allows up to 5 hashtags on a reel or post. Use fewer, more targeted hashtags rather than many generic ones. | @creators on Threads, "Starting today, Instagram will allow up to 5 hashtags in a reel or post" (https://www.threads.com/@creators/post/DSalXGPCWM4), reported by Social Media Today on Dec 18 2025 (https://www.socialmediatoday.com/news/instagram-implements-new-limits-on-hashtag-use/808309/) | Yes: more than 5 are cut to 5; generic tags (#reels, #explore, #fyp, #viral …) are dropped |
| IG2 | **Keywords and hashtags go in the caption, not the comments.** Search matches what people type against usernames, bios, captions, hashtags and places. | Adam Mosseri, "Breaking Down How Instagram Search Works", about.instagram.com, Aug 25 2021 (https://about.instagram.com/blog/announcements/break-down-how-instagram-search-works); "Tips for Improving Your Reach", creators.instagram.com, May 31 2023 (https://creators.instagram.com/blog/tips-for-improving-your-reach) | Prompt (plain search words for the topic and her area); hashtags are always written into the caption |
| IG3 | **The first line has to work on its own.** Only the first two lines show before "more"; open with a question, a surprising fact or a teaser. | Instagram post on captions (https://www.instagram.com/p/Db_N-P6kbt2/), reported by Social Media Today on Aug 23 2026 (https://www.socialmediatoday.com/news/instagram-stresses-the-importance-of-captions/828554/) | Yes: the first line is at most 90 characters (our measure of two lines on a phone, not an Instagram number) |
| IG4 | **Give people something worth saving or sending.** Tell a short story or share useful information people want to save or forward. | Instagram post on captions (https://www.instagram.com/p/Db_N-P6kbt2/), reported by Social Media Today on Aug 23 2026 | Prompt |
| IG5 | **Sends, full watches and likes are what Reels ranking predicts most.** "The most important predictions we make are how likely you are to reshare a reel, watch a reel all the way through, like it, and go to the audio page." | Adam Mosseri, "Instagram Ranking Explained", about.instagram.com, May 31 2023 (https://about.instagram.com/blog/announcements/instagram-ranking-explained) | Prompt (the caption backs up the video's point so it is worth sending; it never asks for sends) |
| IG6 | **Say the next step.** Captions should tell people what to do next (save it for later, the link in bio). | Instagram post on captions (https://www.instagram.com/p/Db_N-P6kbt2/), reported by Social Media Today on Aug 23 2026 | Yes: exactly one CTA, last line before the hashtags |
| IG7 | **No engagement bait.** Meta defines it as posts that explicitly ask for votes, shares, comments, tags, likes or other reactions. Instagram said it won't recommend content that asks people to comment with a specific word, number or emoji to game reach; open-ended questions and calls to action are fine. | Meta Transparency Center, "Engagement Bait" (https://transparency.meta.com/features/approach-to-ranking/content-distribution-guidelines/engagement-bait), read Oct 23 2026; @creators video, reported by Social Media Today on Jun 5 2024 (https://www.socialmediatoday.com/news/instagram-clarifies-advice-on-single-word-ctas-and-longer-reels/718151/) | Yes: "tag a friend", "like if", "comment YES", "comment a word/emoji", "share this with N friends", "double tap" are replaced by her strategy's CTA or a plain ask |
| IG8 | **Short paragraphs and line breaks** make a caption easier to read. | Instagram post on captions (https://www.instagram.com/p/Db_N-P6kbt2/), reported by Social Media Today on Aug 23 2026 | Yes: the caption is assembled as hook, blank line, body, blank line, CTA, blank line, hashtags |
| IG9 | **Original content.** Post content you filmed yourself; reposted, watermarked or recycled reels are less likely to be recommended. | "What Creators Need To Know About Instagram Recommendations", creators.instagram.com, Aug 30 2022, updated Apr 25 2023 (https://creators.instagram.com/blog/instagram-recommendations-eligibility-tips-creators) | Not a caption rule; every program video is her own footage |

Not found in a primary source, so not used as a rule: an exact character
count before "more" (trade blogs say 125), a "best" caption length, and the
2,200-character caption cap (trade blogs; the hub has always clipped captions
at 2,200 characters and still does).

## House rules (Jordan)

| # | Rule | Checked in code? |
|---|------|------------------|
| H1 | Her own voice: first person, the way she talks on camera. | Prompt |
| H2 | No invented facts, numbers or quotes. Only the transcript of the final cut, the script and her strategy. When the transcript and the script differ, the transcript wins. | Yes: a sentence with a number that is in none of the sources is removed and listed as a gap |
| H3 | No em dashes or en dashes. | Yes: rewritten as a comma or a period |
| H4 | The CTA is tied to her strategy's goal, in the style of her strategy's Caption CTA Examples. When the strategy names no offer, no free guides, checklists, downloads or discounts. | Yes: an invented offer is replaced |
| H5 | Fair housing: never say who a home, street, town or school area is "perfect" or "ideal" for by family status, religion, race, national origin, sex, disability or age ("perfect for families", "family-friendly", "great for retirees"). Describe the place, not the people. | Yes: such a sentence is removed and listed as a gap |
| H6 | Short and plain. One caption per approved version; the client or the office edits it from there. | Yes: one automatic draft per version |

## How it runs

- A monthly program video version is approved in the Review Room. Its
  transcript is requested (Deepgram nova-3, English, smart formatting).
- The AI work job (every 15 minutes, `/api/cron/topics`) transcribes it and
  then drafts the caption once, from the transcript, the script and a short
  strategy excerpt, on Sonnet 5.5 (the model map's Sonnet entry). No review or
  rewrite loop.
- No transcript can come (no hosted file, the provider failed, no provider)
  or none after 3 hours: the caption is drafted from the script and says so.
- A caption a client or the office edited is never changed. A new approved
  version gets its own draft; the older version's automatic draft goes stale.
- Gated by the `caption_assistant` switch and the program rollout, the
  `ai_runs` switch, the daily AI limits, and a stop while the AI account is
  refusing (the usage limit).
