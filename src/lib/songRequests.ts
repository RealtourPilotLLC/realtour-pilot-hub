import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthDay } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// A SONG THE CLIENT ASKED FOR GOES ON THE VIDEO'S MUSIC NOTE (Oct 16 2026).
//
// Joe Sutow, Aug 25: "As for the song... just use Sweet home Alabama." Tabitha
// Heit, Aug 24: a Spotify link. Georgiana Torrella, Oct 12: a SoundCloud link
// "for the 2625 Wassergass rd listing". Each was in a text and in nobody's
// brief: the editor's "Music:" line reads the video's own music note
// (DeliverableOutput.briefJson, section "music"), and nothing ever wrote a
// client's song there. Kyle, Aug 24: "the song isnt in the notes".
//
// So a client's change request (text, email, portal, a call's own words) that
// names a song or carries a music link adds one line to that video's music
// note: "Client asked for: <song or link> (<who>, by <channel>, <day>)."
//   · Never replaces anything: a person's own music choice stays, and the
//     line goes under it.
//   · Idempotent: a song already on the note is not written again.
//   · WHICH VIDEO: the one the ask is pinned to; else the videos the work
//     order's music items name; else the job's only video. With several videos
//     and nothing saying which, no video's note is touched: the timeline says
//     so, and the work order still carries the ask.
// ---------------------------------------------------------------------------

/** Always music. */
const MUSIC_LINK = /https?:\/\/(?:open\.spotify\.com|spotify\.link|music\.apple\.com|itunes\.apple\.com|(?:on\.|m\.|www\.)?soundcloud\.com|soundcloud\.app\.goo\.gl|music\.youtube\.com|(?:www\.)?tiktok\.com\/music)\/[^\s<>"'”’)\]]+/gi;
/** Music only when the message talks about music (a YouTube link is as often a reference video). */
const MAYBE_MUSIC_LINK = /https?:\/\/(?:(?:www\.|m\.)?youtube\.com|youtu\.be|(?:www\.|vm\.|vt\.)?tiktok\.com)\/[^\s<>"'”’)\]]+/gi;
const MUSIC_WORD = /\b(?:songs?|music|track|tune|soundtrack|audio|sound|spotify|soundcloud|apple music)\b/i;

/** Words that are never a title or an artist on their own. */
const NOT_A_NAME = new Set([
  "the", "this", "that", "these", "those", "a", "an", "any", "same", "new", "different", "another", "other", "your", "my", "our", "their",
  "his", "her", "its", "background", "original", "actual", "copyright", "youtube", "spotify", "soundcloud", "tiktok", "it", "one", "some",
  "i", "we", "you", "they", "he", "she", "today", "today's", "video", "music", "song", "track", "please", "just", "also", "can", "could",
]);
/** Where a spoken title stops: "use Sweet Home Alabama for the intro please". */
const TITLE_STOP = /\s+(?:for|on|in|instead|please|at|and|but|as|if|so|because|with|from|when|during|over|under|to|works?|too|again|here|there|thanks?)\b.*$/i;

const tidy = (s: string) => s.replace(/\s+/g, " ").replace(/^["“'‘\s]+|["”'’\s.,!?;:]+$/g, "").trim();
const isName = (s: string) => {
  const words = s.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && s.length >= 2 && s.length <= 90 && !words.every((w) => NOT_A_NAME.has(w.replace(/[^\p{L}\p{N}'’]/gu, "")));
};
/** A title someone typed reads like one: most words capitalised ("Sweet home
 *  Alabama", "Caught Up In The Country"), not a sentence ("Can you send the
 *  video"), and not a word for music itself ("Facebook audio"). */
const SMALL = new Set(["a", "an", "the", "of", "in", "on", "to", "and", "or", "up", "at", "for", "by", "my", "me", "you", "your"]);
const looksLikeTitle = (s: string) => {
  const words = s.split(/\s+/).map((w) => w.replace(/^[("'“‘]+|[)"'”’.,!?]+$/g, "")).filter(Boolean);
  if (words.length === 0 || words.length > 9) return false;
  if (/\b(?:audio|music|songs?|sound|track|video|clip)$/i.test(s.trim())) return false;
  const big = words.filter((w) => /^[\p{Lu}\p{N}]/u.test(w)).length;
  const counted = words.filter((w) => !SMALL.has(w.toLowerCase())).length || 1;
  return big / counted >= 0.6;
};

/**
 * Every song or music link in the client's words, as it should read on the
 * note ("Sweet home Alabama", "Caught Up In The Country (Sam Feldt Remix) by
 * Rodney Atkins", a link). Pure; empty when nothing names a song.
 */
export function findSongAsks(text: string | null | undefined): string[] {
  const t = (text ?? "").replace(/\r\n/g, "\n");
  if (!t.trim()) return [];
  const out: string[] = [];
  const add = (s: string) => {
    const v = tidy(s);
    if (!v) return;
    const k = songKey(v);
    if (!out.some((o) => songKey(o) === k || (k.length > 3 && songKey(o).includes(k)) || (songKey(o).length > 3 && k.includes(songKey(o))))) out.push(v);
  };
  // Links first: they are unambiguous.
  for (const m of t.matchAll(MUSIC_LINK)) add(m[0]);
  if (MUSIC_WORD.test(t)) for (const m of t.matchAll(MAYBE_MUSIC_LINK)) add(m[0]);
  // Named songs, only in a sentence that talks about music.
  const sentences = t.replace(/https?:\/\/\S+/g, " ").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const musical = (i: number) => MUSIC_WORD.test(sentences[i]) || MUSIC_WORD.test(sentences[i - 1] ?? "") || /#?soundcloud|spotify/i.test(t);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    // "Title" by Artist names a song on its own ("Please use "Golden Hour" by
    // JVKE for the reel"); everything else needs the sentence to be about music.
    for (const m of s.matchAll(/["“]([^"“”\n]{2,80})["”]\s+by\s+([A-Z][^\n.,!?;"“”]{1,40})/g)) {
      if (isName(m[1])) add(`${m[1]} by ${tidy(m[2]).replace(TITLE_STOP, "")}`);
    }
    if (!musical(i)) continue;
    // "Title"
    for (const m of s.matchAll(/["“]([^"“”\n]{2,80})["”](?!\s+by\s+[A-Z])/g)) {
      if (isName(m[1])) add(m[1]);
    }
    // Title by Artist (capitalised title)
    for (const m of s.matchAll(/\b([A-Z][\w'’&.-]*(?:\s+[\w'’&().-]+){0,8}?)\s+by\s+([A-Z][\w'’&.-]*(?:\s+[A-Z][\w'’&.-]*){0,3})/g)) {
      const title = m[1].replace(/^(?:use|play|try|the song|song)\s+/i, "");
      if (isName(title) && looksLikeTitle(title)) add(`${title} by ${m[2]}`);
    }
    // use / play / go with / switch to / change the song to <Title>
    for (const m of s.matchAll(/\b(?:use|play|try|go with|switch(?:\s+it)?\s+to|change\s+(?:it|the\s+(?:song|music|track|audio))\s+to)\s+(?:the\s+(?:song|track)\s+)?([A-Z][\w'’&-]*(?:\s+[\w'’&-]+){0,6})/g)) {
      const title = m[1].replace(TITLE_STOP, "");
      if (isName(title) && looksLikeTitle(title)) add(title);
    }
    // the Noah Kahan song / Noah Kahan's song
    for (const m of s.matchAll(/\b(?:the\s+)?([A-Z][\w'’]+(?:\s+[A-Z][\w'’]+){0,3})(?:'s|’s)?\s+(?:actual\s+|original\s+)?song\b/g)) {
      if (isName(m[1])) add(`a ${m[1].replace(/(?:'s|’s)$/, "")} song`);
    }
  }
  return out.slice(0, 5);
}

/** What makes two mentions the same song: a link without its tracking, or the
 *  title's letters. */
export function songKey(s: string): string {
  const v = s.trim();
  if (/^https?:\/\//i.test(v)) return v.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  return v.toLowerCase().replace(/^a\s+|\s+song$/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The music note with the line added under what is there, or null when every
 *  song is already on it. Pure. */
export function musicNoteWith(existing: string | null | undefined, asks: string[], tail: string): string | null {
  const cur = (existing ?? "").trim();
  const have = songKey(cur);
  const curLow = cur.toLowerCase();
  const fresh = asks.filter((a) => {
    const k = songKey(a);
    return k && !(/^https?:/.test(k) ? curLow.includes(k) : have.includes(k));
  });
  if (fresh.length === 0) return null;
  const line = `Client asked for: ${fresh.join(" · ")} (${tail}).`;
  return cur ? `${cur}\n${line}` : line;
}

const CHANNEL: Record<string, string> = {
  openphone: "text", comms: "text", "openphone-call": "phone call", gmail: "email", email: "email",
  portal: "the portal", portal_message: "a portal message", team_message: "the team chat", review_room_staff: "staff for the client",
};

export type SongNoteResult = { asks: string[]; written: string[]; skipped?: string };

/**
 * The song(s) a brief's words name, onto the music note of the video(s) it is
 * about. Never throws; returns what it did.
 */
export async function noteSongRequestsFromBrief(briefId: string): Promise<SongNoteResult> {
  try {
    const b = await prisma.revisionBrief.findUnique({
      where: { id: briefId },
      select: { id: true, projectId: true, source: true, originalText: true, twoSided: true, outputId: true, itemsJson: true, createdAt: true, requestedBy: true },
    });
    if (!b) return { asks: [], written: [], skipped: "no brief" };
    // A call transcript carries our own side too; an office row is not a client's ask.
    if (b.twoSided || b.source === "office") return { asks: [], written: [], skipped: "not the client's own words" };
    const asks = findSongAsks(b.originalText);
    if (asks.length === 0) return { asks, written: [] };
    // Which videos: the pin, else the work order's music items, else the only video.
    let keys: string[] = [];
    if (!b.outputId) {
      try {
        const items = ((JSON.parse(b.itemsJson ?? "{}") as { items?: { area?: string; cuts?: string[] | null }[] }).items ?? []);
        keys = [...new Set(items.filter((i) => i.area === "Music & sound").flatMap((i) => i.cuts ?? []).filter(Boolean))];
      } catch { keys = []; }
    }
    return await writeSongNote({ projectId: b.projectId, asks, outputId: b.outputId, slotKeys: keys, who: b.requestedBy, channel: CHANNEL[b.source] ?? b.source, at: b.createdAt });
  } catch (e) {
    console.error("[song requests] brief note failed", briefId, e);
    return { asks: [], written: [], skipped: "failed" };
  }
}

/** The same for a client message that is not a revision (a job still being
 *  made: "can we use this song for the listing"). Never throws. */
export async function noteSongRequestFromMessage(opts: { projectId: string; text: string; source: string; who?: string | null; at?: Date }): Promise<SongNoteResult> {
  try {
    const asks = findSongAsks(opts.text);
    if (asks.length === 0) return { asks, written: [] };
    return await writeSongNote({ projectId: opts.projectId, asks, outputId: null, slotKeys: [], who: opts.who ?? null, channel: CHANNEL[opts.source] ?? opts.source, at: opts.at ?? new Date() });
  } catch (e) {
    console.error("[song requests] message note failed", opts.projectId, e);
    return { asks: [], written: [], skipped: "failed" };
  }
}

async function writeSongNote(o: { projectId: string; asks: string[]; outputId: string | null; slotKeys: string[]; who: string | null; channel: string; at: Date }): Promise<SongNoteResult> {
  const { saveOutputBrief, readOutputBrief } = await import("@/lib/deliverableOutputs");
  const { cutSlots, slotKeyOf } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(o.projectId).catch(() => []);
  const owned = await prisma.deliverableOutput.findMany({
    where: { projectId: o.projectId, removedFromOrderAt: null, waivedAt: null },
    select: { id: true, deliverableId: true, slot: true, title: true },
  });
  const owedKeys = new Set(slots.map((s) => slotKeyOf(s.deliverableId, s.slot)));
  const labelOf = new Map(slots.map((s) => [slotKeyOf(s.deliverableId, s.slot), s.label]));
  const owedOutputs = owned.filter((x) => owedKeys.has(slotKeyOf(x.deliverableId, x.slot)));
  let targets = o.outputId
    ? owned.filter((x) => x.id === o.outputId)
    : o.slotKeys.length
      ? owedOutputs.filter((x) => o.slotKeys.includes(slotKeyOf(x.deliverableId, x.slot)))
      : owedOutputs.length === 1 && slots.length === 1 ? owedOutputs : [];
  targets = targets.slice(0, 6);
  const tail = [o.who?.trim() || null, `by ${o.channel}`, etMonthDay(o.at)].filter(Boolean).join(", ");
  const songs = o.asks.join(" · ");
  if (targets.length === 0) {
    const body = `The client asked for a song: ${songs}. Which video it is for isn't clear, so no video's music note was changed. Add it to the right video's brief.`.slice(0, 1000);
    const had = await prisma.activity.findFirst({ where: { projectId: o.projectId, body }, select: { id: true } });
    if (!had) await prisma.activity.create({ data: { projectId: o.projectId, type: "SYSTEM", body } }).catch(() => {});
    return { asks: o.asks, written: [], skipped: "which video is unclear" };
  }
  const written: string[] = [];
  for (const t of targets) {
    // An append cannot overwrite anything; a save that raced another is
    // tried again on the newer note (the onsite-note rule), three times.
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await prisma.deliverableOutput.findUnique({ where: { id: t.id }, select: { briefJson: true } });
      const cur = readOutputBrief(row?.briefJson);
      const next = musicNoteWith(cur?.sections.music ?? null, o.asks, tail);
      if (next === null) break; // already on it
      const r = await saveOutputBrief({ outputId: t.id, projectId: o.projectId, sections: { music: next }, expectedVersion: cur?.version ?? null, actor: "Hub (the client's song request)" });
      if (r.ok) {
        if (r.changed) {
          written.push(t.id);
          const name = t.title?.trim() || labelOf.get(slotKeyOf(t.deliverableId, t.slot)) || `video ${t.slot}`;
          await prisma.activity.create({ data: { projectId: o.projectId, type: "SYSTEM", body: `The client's song request was added to the music note for “${name}”: ${songs}.`.slice(0, 1000) } }).catch(() => {});
        }
        break;
      }
      if (r.reason !== "conflict") break; // too long, not owed: leave it to a person
    }
  }
  return { asks: o.asks, written };
}
