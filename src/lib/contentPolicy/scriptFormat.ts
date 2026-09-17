// ---------------------------------------------------------------------------
// The canonical script type, the archive reader, the renderer, the spoken-time
// estimator and the NEW-script validator.
//
// Two different jobs, deliberately kept apart:
//   parseDeliveredScript()  READS the archive faithfully — every label variant
//                           in manifest §4.1, four talking points and all,
//                           separate RE-HOOK / PAYOFF blocks, two-voice scripts,
//                           stage directions, production notes, placeholders.
//                           It never "fixes" an old script.
//   validateNewScript()     HOLDS new generation to the policy — exactly three
//                           roled points, hook, close, timing, no greeting,
//                           pillar link — and carries gap objects through.
//
// Word rule (manifest §4.3): spoken = hook + points + separately labelled
// spoken re-hook/payoff blocks (archive only) + close. Labels, notes, stage
// directions and the caption are never spoken. Seconds = words ÷ 2.2.
//
// Pure. No DB, no AI.
// ---------------------------------------------------------------------------

import {
  GENERATION_POLICY,
  type Finding,
  type Gap,
  type PolicyStamp,
  type QualityDimension,
  type TalkingPointRole,
  TALKING_POINT_ROLES,
  TALKING_POINT_ROLE_SPECS,
  countSpokenWords,
  makeGap,
  roleFromLabel,
} from "./policy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PillarRef = {
  /** Versioned pillar identity once the importer has mapped it; null until then (C-A6). */
  pillarId: string | null;
  /** The primary pillar name as written (first segment of a " / " or " • " list). */
  pillarName: string | null;
  /** The whole category line, untouched. */
  categoryAsDelivered: string | null;
  /** Further segments of a multi-pillar / tag category line. */
  secondary: string[];
};

export type SpokenBlock = {
  /** Label as delivered ("TALKING POINT 1 - RE-HOOK", "OUTRO", "HOOK:"), or null for a generated block. */
  label: string | null;
  /** Lines exactly as delivered (speaker labels and stage directions removed). */
  lines: string[];
  /** The spoken text, lines joined with a space. */
  text: string;
  /** `[dir]` / bracketed stage directions found inside the block — never spoken. */
  stageDirections: string[];
  /** Speaker labels seen in this block ("MIKE", "JAMES, OFF CAMERA", "SARINA"). */
  speakers: string[];
};

export type TalkingPoint = SpokenBlock & {
  index: number;
  role: TalkingPointRole | null;
  roleSource: "label" | "position" | "generated" | null;
};

export type ExtraSpokenBlock = SpokenBlock & { kind: "re-hook" | "payoff" | "other" };

/** Per-script internal-only fields (C-A9). Rendered to the client never; kept for filming. */
export type ScriptInternal = {
  goal: string | null;
  creativeDirection: string | null;
  filmingNotes: string | null;
  productionNotes: string[];
  placeholders: string[];
  speakerLabels: string[];
  /** A duration the SOURCE page states ("60–75 seconds"). Source text only — not a target, not an override. */
  durationStated: string | null;
  props: string | null;
  otherBlocks: { label: string; text: string }[];
  /** GPT "CONTENT PILLAR CHECK" — one line per dimension, internal reviewer text, never a score (C-A7). */
  contentPillarCheck: Partial<Record<QualityDimension, string>> | null;
  sourceExcerpts: string[];
  alternateHooks: string[];
};

export type CanonicalScript = {
  title: string;
  titleAsDelivered: string | null;
  number: number | null;
  pillarRef: PillarRef | null;
  hook: SpokenBlock | null;
  points: TalkingPoint[];
  /** Archive-only: separately labelled spoken RE-HOOK / PAYOFF blocks (Hutton Apr, Spinelli). Empty for new scripts. */
  extraSpokenBlocks: ExtraSpokenBlock[];
  close: SpokenBlock | null;
  captionCta: string | null;
  /** Owning client, when known (set by the generator path / the importer). Lets prompts.ts refuse a foreign script. */
  clientId: string | null;
  internal: ScriptInternal;
  /** Gap objects the generator emitted (or the parser found, e.g. placeholders). */
  gaps: Gap[];
  stamp: PolicyStamp | null;
  parseWarnings: string[];
};

export function emptyInternal(): ScriptInternal {
  return {
    goal: null,
    creativeDirection: null,
    filmingNotes: null,
    productionNotes: [],
    placeholders: [],
    speakerLabels: [],
    durationStated: null,
    props: null,
    otherBlocks: [],
    contentPillarCheck: null,
    sourceExcerpts: [],
    alternateHooks: [],
  };
}

export function makeBlock(text: string, label: string | null = null): SpokenBlock {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { label, lines, text: lines.join(" "), stageDirections: [], speakers: [] };
}

// ---------------------------------------------------------------------------
// Label recognition — every variant in manifest §4.1
// ---------------------------------------------------------------------------

const TITLE_NUMBER_RE = /^(\d{1,2})[.)]\s+(.+)$/;
const VIDEO_HEAD_RE = /^VIDEO\s*(\d{1,2})\s*\|\s*(.+)$/i; // Flatley: "VIDEO 1 | MIKE FLATLEY" (title on the next line)
const VIDEO_TITLE_RE = /^VIDEO\s*(\d{1,2})\s*[—–-]\s*(.+)$/i; // Spinelli: "VIDEO 1 — Title"
const CATEGORY_RE = /^(?:Video\s+)?Category\s*:\s*(.*)$/i;
const CATEGORY_BARE_RE = /^CATEGORY$/i;
const GOAL_RE = /^Goal\s*:\s*(.*)$/i;
const TITLE_LABEL_RE = /^(?:Video\s+Topic\s+)?Title\s*:\s*(.*)$/i;
const HOOK_RE = /^HOOK(?:\s*:\s*(.*))?$/i;
const TP_RE =
  /^TALKING\s+POINT\s*#?\s*(\d{1,2})(?:\s*(?:[-–—:]\s*|\(\s*)?(RE-?HOOK|RE HOOK|SET-?UP|SET UP|BUILD[ -]?UP|PAY-?OFF|CONTEXT)(?=\s*[):\-–—]|\s*$)\)?)?(?:\s*[:\-–—]\s*(.+))?\s*$/i;
const TPS_RE = /^TALKING\s+POINTS(?:\s*:\s*(.*))?$/i;
const REHOOK_RE = /^RE-?HOOK(?:\s*:\s*(.*))?$/i;
const PAYOFF_RE = /^PAYOFF(?:\s*:\s*(.*))?$/i;
const CLOSE_RE = /^(CLOSE(?:\s*\/\s*(?:CALL\s+TO\s+ACTION|CTA))?|OUTRO|CALLBACK\s*\/\s*CTA|CALL\s+TO\s+ACTION|CTA)(?:\s*:\s*(.*))?$/i;
const CAPTION_RE = /^((?:OPTIONAL\s+)?CAPTION(?:\s+CTA)?)(?:\s*:\s*(.*))?$/i;
const CREATIVE_RE = /^CREATIVE\s+DIRECTION(?:\s*:\s*(.*))?$/i;
const FILMING_RE = /^FILMING\s+NOTES?(?:\s*:\s*(.*))?$/i;
const PRODUCTION_RE = /^Production\s+notes?\s*:\s*(.*)$/i;
const PILLAR_CHECK_RE = /^CONTENT\s+PILLAR\s+CHECK\s*:?$/i;
const DIMENSION_LINE_RE = /^[-•]?\s*(Trust|Value|Credibility|Entertainment)\s*:\s*(.*)$/i;
const BULLET_RE = /^\s*(?:[•●▪◦\-–—*]|\d{1,2}[.)])\s+(.*)$/;
const STAGE_RE = /^\[dir\]\s*(.*)$/i;
const BRACKET_LINE_RE = /^\[[^\]]+\]$/;
const SPEAKER_INLINE_RE = /^([A-Z][A-Z ,.'’\-]{0,30}?)\s*:\s+(.+)$/;
const SPEAKER_ALONE_RE = /^([A-Z][A-Z ,.'’\-]{0,30}?)\s*:$/;
const PLACEHOLDER_RE = /\$?\[[A-Z][A-Z0-9 _\-]*\]/g;
const PLACEHOLDER_TEST_RE = /\$?\[[A-Z][A-Z0-9 _\-]*\]/; // no `g`: a global regex keeps lastIndex between .test() calls
// The one archive shape (Bernadette Aug #4): a LAST close line that attributes the
// script's angles to the client's call — "…all came directly from X’s discussion on
// the call." Only that shape is moved to production notes; a spoken close that
// merely mentions "on the call" stays spoken.
const PROVENANCE_RE = /\b(came directly from\b.*\bdiscussion|discussion on the call|from (the )?(client’s|client's) discussion on the call)/i;

type BlockKind = "hook" | "point" | "points-list" | "rehook" | "payoff" | "close" | "caption" | "creative" | "filming" | "pillar-check" | "other";

function isAllCapsLabel(line: string): boolean {
  if (line.length > 40) return false;
  if (/[.?!…]$/.test(line)) return false;
  if (!/[A-Z]/.test(line) || /[a-z]/.test(line)) return false;
  return line.split(/\s+/).length <= 5;
}

function newBlock(label: string | null): SpokenBlock {
  return { label, lines: [], text: "", stageDirections: [], speakers: [] };
}

function finishBlock(b: SpokenBlock | null): void {
  if (b) b.text = b.lines.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Read ONE delivered script exactly as written. Accepts every label variant in
 * the archive (manifest §4.1). Returns four points when there are four, keeps
 * separate RE-HOOK / PAYOFF blocks, two-voice speaker labels, stage directions,
 * production notes, placeholders and the stated duration. Never throws.
 */
export function parseDeliveredScript(text: string): CanonicalScript {
  const warnings: string[] = [];
  const internal = emptyInternal();
  const script: CanonicalScript = {
    title: "",
    titleAsDelivered: null,
    number: null,
    pillarRef: null,
    hook: null,
    points: [],
    extraSpokenBlocks: [],
    close: null,
    captionCta: null,
    clientId: null,
    internal,
    gaps: [],
    stamp: null,
    parseWarnings: warnings,
  };

  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));

  // `null as …` keeps the declared type: TS would otherwise narrow these `let`s to
  // null and never see the assignments the closures below make.
  let kind = null as BlockKind | null;
  let block = null as SpokenBlock | null;
  let listPoint = null as TalkingPoint | null;
  let listSawBullet = false;
  let otherLabel: string | null = null;
  const otherLines: string[] = [];
  const captionLines: string[] = [];
  const creativeLines: string[] = [];
  const filmingLines: string[] = [];
  const speakerSet = new Set<string>();
  let titleDone = false;
  let expectTitleNext = false;
  let expectCategoryTags = false;
  let currentSpeaker: string | null = null;

  const flushOther = () => {
    if (otherLabel != null) internal.otherBlocks.push({ label: otherLabel, text: otherLines.join("\n").trim() });
    otherLabel = null;
    otherLines.length = 0;
  };

  const closeCurrent = () => {
    finishBlock(block);
    if (kind === "close") moveCloseProvenance();
    if (kind === "points-list" && listPoint) finishBlock(listPoint);
    flushOther();
    block = null;
    listPoint = null;
    kind = null;
    currentSpeaker = null;
  };

  const startSpoken = (k: BlockKind, label: string, inline: string | undefined) => {
    closeCurrent();
    kind = k;
    block = newBlock(label);
    if (k === "point") {
      const tpm = TP_RE.exec(label);
      const roleLabel = tpm?.[2] ?? null;
      const role = roleFromLabel(roleLabel);
      const tp: TalkingPoint = { ...block, index: script.points.length + 1, role, roleSource: role ? "label" : null };
      script.points.push(tp);
      block = tp;
    } else if (k === "hook") script.hook = block;
    else if (k === "close") script.close = block;
    else if (k === "rehook" || k === "payoff") {
      const extra: ExtraSpokenBlock = { ...block, kind: k === "rehook" ? "re-hook" : "payoff" };
      script.extraSpokenBlocks.push(extra);
      block = extra;
    }
    if (inline && inline.trim()) pushSpokenLine(inline.trim());
  };

  const pushSpokenLine = (raw: string) => {
    const target: SpokenBlock | null = kind === "points-list" ? listPoint : block;
    if (!target) return;
    let line = raw;
    const alone = SPEAKER_ALONE_RE.exec(line);
    if (alone && !isKnownLabel(alone[1])) {
      currentSpeaker = alone[1].trim();
      speakerSet.add(currentSpeaker);
      if (!target.speakers.includes(currentSpeaker)) target.speakers.push(currentSpeaker);
      return;
    }
    const inlineSpk = SPEAKER_INLINE_RE.exec(line);
    if (inlineSpk && !isKnownLabel(inlineSpk[1]) && /^[A-Z][A-Z ,.'’\-]*$/.test(inlineSpk[1]) && inlineSpk[1].length <= 30 && isSpeakerToken(inlineSpk[1].trim())) {
      currentSpeaker = inlineSpk[1].trim();
      speakerSet.add(currentSpeaker);
      if (!target.speakers.includes(currentSpeaker)) target.speakers.push(currentSpeaker);
      line = inlineSpk[2];
    }
    target.lines.push(line);
  };

  // A line-initial "NAME:" is a speaker label only in a dialogue script: the token
  // is alone on a line somewhere, or recurs, or the script already has such a
  // speaker (Flatley's one-off "JAMES, OFF CAMERA:" beside MIKE ×2). A single
  // "PSA:" in a one-voice script is spoken text, not a speaker.
  const dialogueSpeakers = prescanSpeakers(lines);
  function isSpeakerToken(token: string): boolean {
    // Known dialogue speaker, or any "NAME:" inside a script that IS a dialogue.
    return dialogueSpeakers.has(token) || dialogueSpeakers.size > 0;
  }

  // Blocker fix: the provenance move is a post-pass on the finished CLOSE block,
  // limited to its LAST line and the archive's exact attribution shape.
  const moveCloseProvenance = () => {
    const c = script.close;
    if (!c || !c.lines.length) return;
    const last = c.lines[c.lines.length - 1];
    if (countSpokenWords(last) >= 15 && PROVENANCE_RE.test(last)) {
      c.lines.pop();
      finishBlock(c);
      internal.productionNotes.push(last);
      warnings.push("the last line of the close attributes the angles to the client's call (provenance, not spoken) — moved to production notes");
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;

    // --- stage directions (never spoken) -----------------------------------
    const dir = STAGE_RE.exec(t) ?? (BRACKET_LINE_RE.test(t) && !PLACEHOLDER_TEST_RE.test(t) ? [t, t.slice(1, -1)] : null);
    if (dir) {
      const d = dir[1].trim();
      if (kind === "filming") filmingLines.push(d);
      else if (kind === "creative") creativeLines.push(d);
      else if (block) block.stageDirections.push(d);
      else if (kind === "points-list" && listPoint) listPoint.stageDirections.push(d);
      else internal.otherBlocks.push({ label: "[stage direction]", text: d });
      continue;
    }

    // --- title / head lines --------------------------------------------------
    if (!titleDone) {
      const head = VIDEO_HEAD_RE.exec(t);
      if (head) {
        script.number = Number(head[1]);
        script.titleAsDelivered = t;
        expectTitleNext = true;
        continue;
      }
      if (expectTitleNext) {
        script.title = t;
        script.titleAsDelivered = `${script.titleAsDelivered}\n${t}`;
        expectTitleNext = false;
        titleDone = true;
        // Flatley meta line follows: "Pillar • 60–75 seconds • Prop: Phone"
        const next = lines[i + 1]?.trim() ?? "";
        if (next.includes(" • ")) {
          const segs = next.split(" • ").map((s) => s.trim());
          const category = segs[0];
          for (const s of segs.slice(1)) {
            if (/second|unscripted|minute/i.test(s)) internal.durationStated = s;
            else if (/^(prop|no props)/i.test(s)) internal.props = s.replace(/^Prop:\s*/i, "");
            else internal.otherBlocks.push({ label: "[meta]", text: s });
          }
          script.pillarRef = pillarRefFromCategory(category);
          i += 1;
        }
        continue;
      }
      const tl = TITLE_LABEL_RE.exec(t);
      if (tl) {
        if (tl[1].trim()) {
          script.title = tl[1].trim();
          script.titleAsDelivered = t;
          titleDone = true;
        }
        continue; // bare "Video Topic Title:" label — the title is on the next line
      }
      const vt = VIDEO_TITLE_RE.exec(t);
      if (vt) {
        script.number = Number(vt[1]);
        script.title = vt[2].trim();
        script.titleAsDelivered = t;
        titleDone = true;
        continue;
      }
      if (isKnownLabel(t) || TP_RE.test(t) || PRODUCTION_RE.test(t) || CATEGORY_RE.test(t) || GOAL_RE.test(t)) {
        // No title line at all — the script opens on a label. Do not eat the
        // label as the title; fall through and parse it.
        titleDone = true;
        warnings.push("title.missing: the script opens on a label, no title line");
      } else {
        const num = TITLE_NUMBER_RE.exec(t);
        if (num) {
          script.number = Number(num[1]);
          script.title = num[2].trim();
        } else script.title = t;
        script.titleAsDelivered = t;
        titleDone = true;
        continue;
      }
    }

    // --- metadata lines ------------------------------------------------------
    if (expectCategoryTags) {
      script.pillarRef = pillarRefFromCategory(t);
      expectCategoryTags = false;
      continue;
    }
    const cat = CATEGORY_RE.exec(t);
    if (cat) {
      script.pillarRef = pillarRefFromCategory(cat[1].trim());
      continue;
    }
    if (CATEGORY_BARE_RE.test(t)) {
      expectCategoryTags = true;
      continue;
    }
    const goal = GOAL_RE.exec(t);
    if (goal) {
      internal.goal = goal[1].trim();
      continue;
    }
    const prod = PRODUCTION_RE.exec(t);
    if (prod) {
      closeCurrent();
      internal.productionNotes.push(prod[1].trim());
      kind = "other";
      otherLabel = null; // continuation lines of a production note append below
      continue;
    }

    // --- section labels ------------------------------------------------------
    let m: RegExpExecArray | null;
    if ((m = HOOK_RE.exec(t))) {
      startSpoken("hook", "HOOK", m[1]);
      continue;
    }
    if ((m = TPS_RE.exec(t))) {
      closeCurrent();
      kind = "points-list";
      listSawBullet = false;
      listPoint = null;
      if (m[1] && m[1].trim()) {
        listPoint = { ...newBlock("TALKING POINTS"), index: script.points.length + 1, role: null, roleSource: null };
        script.points.push(listPoint);
        pushSpokenLine(m[1].trim());
      }
      continue;
    }
    if ((m = TP_RE.exec(t))) {
      const inline = m[3];
      const label = inline ? t.slice(0, t.length - inline.length).replace(/\s*[:\-–—]\s*$/, "") : t;
      startSpoken("point", label, inline);
      continue;
    }
    if ((m = REHOOK_RE.exec(t))) {
      startSpoken("rehook", "RE-HOOK", m[1]);
      continue;
    }
    if ((m = PAYOFF_RE.exec(t))) {
      startSpoken("payoff", "PAYOFF", m[1]);
      continue;
    }
    if ((m = CLOSE_RE.exec(t))) {
      startSpoken("close", m[1].toUpperCase(), m[2]);
      continue;
    }
    if ((m = CAPTION_RE.exec(t))) {
      closeCurrent();
      kind = "caption";
      if (m[2] && m[2].trim()) captionLines.push(m[2].trim());
      continue;
    }
    if ((m = CREATIVE_RE.exec(t))) {
      closeCurrent();
      kind = "creative";
      if (m[1] && m[1].trim()) creativeLines.push(m[1].trim());
      continue;
    }
    if ((m = FILMING_RE.exec(t))) {
      closeCurrent();
      kind = "filming";
      if (m[1] && m[1].trim()) filmingLines.push(m[1].trim());
      continue;
    }
    if (PILLAR_CHECK_RE.test(t)) {
      closeCurrent();
      kind = "pillar-check";
      internal.contentPillarCheck = internal.contentPillarCheck ?? {};
      continue;
    }
    if (kind === "pillar-check") {
      const d = DIMENSION_LINE_RE.exec(t);
      if (d) {
        const name = (d[1][0].toUpperCase() + d[1].slice(1).toLowerCase()) as QualityDimension;
        internal.contentPillarCheck![name] = d[2].trim();
        continue;
      }
    }
    const inSpoken = kind === "hook" || kind === "point" || kind === "points-list" || kind === "close" || kind === "rehook" || kind === "payoff";
    const spokenTarget = kind === "points-list" ? listPoint : block;
    // Inside a spoken block a short ALL-CAPS line after the block's first line
    // ("ENDING", "WRAP UP") is a label the archive never used, not a shouted line.
    const labelInsideSpoken = inSpoken && !!spokenTarget && spokenTarget.lines.length > 0 && t.split(/\s+/).length <= 3 && !/[,;]/.test(t);
    if (isAllCapsLabel(t) && !SPEAKER_ALONE_RE.test(t) && (labelInsideSpoken || !(inSpoken || kind === "caption"))) {
      // Unknown block label ("THE QUESTION", "INTERVIEW PLAN", "SESSION TIMING") — kept, not spoken.
      closeCurrent();
      kind = "other";
      otherLabel = t;
      warnings.push(`unrecognised label “${t}” kept in internal.otherBlocks (not spoken)`);
      continue;
    }

    // --- body lines ----------------------------------------------------------
    switch (kind) {
      case "caption":
        captionLines.push(t);
        break;
      case "creative":
        creativeLines.push(t);
        break;
      case "filming":
        filmingLines.push(t);
        break;
      case "other":
        if (otherLabel != null) otherLines.push(t);
        else if (internal.productionNotes.length) internal.productionNotes[internal.productionNotes.length - 1] += ` ${t}`;
        else internal.otherBlocks.push({ label: "", text: t });
        break;
      case "points-list": {
        const b = BULLET_RE.exec(t);
        if (b) {
          if (listPoint) finishBlock(listPoint);
          listSawBullet = true;
          listPoint = { ...newBlock(t.slice(0, t.length - b[1].length).trim()), index: script.points.length + 1, role: null, roleSource: null };
          script.points.push(listPoint);
          pushSpokenLine(b[1].trim());
        } else {
          if (!listPoint) {
            // One unnumbered block (Spinelli V2): a single point carrying every line.
            listPoint = { ...newBlock("TALKING POINTS"), index: script.points.length + 1, role: null, roleSource: null };
            script.points.push(listPoint);
          }
          pushSpokenLine(t);
        }
        break;
      }
      case "hook":
      case "point":
      case "rehook":
      case "payoff":
      case "close":
        pushSpokenLine(t);
        break;
      default:
        internal.otherBlocks.push({ label: "", text: t });
        warnings.push(`line ${i + 1} before any labelled block: “${t.slice(0, 50)}”`);
    }
  }
  closeCurrent();
  void listSawBullet;

  if (captionLines.length) script.captionCta = captionLines.join("\n");
  if (creativeLines.length) internal.creativeDirection = creativeLines.join("\n");
  if (filmingLines.length) internal.filmingNotes = filmingLines.join("\n");
  internal.speakerLabels = [...speakerSet];

  // Roles by position for a plain three-point script (C-A3: "plain numbers → by position").
  if (script.points.length === 3 && script.points.every((p) => p.role === null)) {
    script.points.forEach((p, i) => {
      p.role = TALKING_POINT_ROLES[i];
      p.roleSource = "position";
    });
  }

  // Placeholders → gap objects (C-A9: "$[PRICE] cannot be filmed without the lender's numbers").
  const spoken = allSpokenText(script);
  const found = new Set<string>();
  for (const ph of spoken.match(PLACEHOLDER_RE) ?? []) found.add(ph);
  internal.placeholders = [...found];
  for (const ph of internal.placeholders) {
    script.gaps.push(makeGap("placeholder", `Placeholder ${ph} must be supplied before filming.`, { field: "spoken", question: `What is the value for ${ph}?` }));
  }

  if (!script.hook && !script.points.length && !script.close) warnings.push("no HOOK / TALKING POINT / CLOSE labels found — not a scripted piece (an unscripted plan, or a document header)");
  return script;
}

function isKnownLabel(label: string): boolean {
  const l = label.trim();
  return (
    HOOK_RE.test(l) ||
    TPS_RE.test(l) ||
    TP_RE.test(l) ||
    REHOOK_RE.test(l) ||
    PAYOFF_RE.test(l) ||
    CLOSE_RE.test(l) ||
    CAPTION_RE.test(l) ||
    CREATIVE_RE.test(l) ||
    FILMING_RE.test(l) ||
    CATEGORY_BARE_RE.test(l) ||
    /^(category|goal|title|video topic title|production notes?)$/i.test(l)
  );
}

/** Speaker tokens that qualify a script as dialogue: alone on a line, or line-initial "NAME:" at least twice. */
function prescanSpeakers(lines: string[]): Set<string> {
  const counts = new Map<string, number>();
  const out = new Set<string>();
  for (const raw of lines) {
    const t = raw.trim();
    const alone = SPEAKER_ALONE_RE.exec(t);
    if (alone && !isKnownLabel(alone[1])) {
      out.add(alone[1].trim());
      continue;
    }
    const inl = SPEAKER_INLINE_RE.exec(t);
    if (inl && !isKnownLabel(inl[1]) && /^[A-Z][A-Z ,.'’\-]*$/.test(inl[1]) && inl[1].length <= 30) {
      const k = inl[1].trim();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of counts) if (n >= 2) out.add(k);
  return out;
}

export function pillarRefFromCategory(category: string): PillarRef {
  const clean = category.trim();
  const segs = clean
    .split(/\s+(?:\/|•|\||·)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { pillarId: null, pillarName: segs[0] ?? null, categoryAsDelivered: clean || null, secondary: segs.slice(1) };
}

/**
 * Split a multi-script document into one text per script. Boundaries: a
 * "VIDEO n | …" / "VIDEO n — …" head, or a numbered "n. Title" line followed
 * within two lines by a Category line. Everything before the first boundary is
 * returned as `preamble` (cover page, "Included Topics", document header).
 */
export function splitDeliveredScripts(text: string): { preamble: string; scripts: string[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (VIDEO_HEAD_RE.test(t) || VIDEO_TITLE_RE.test(t)) starts.push(i);
    else if (TITLE_NUMBER_RE.test(t)) {
      const n1 = lines[i + 1]?.trim() ?? "";
      const n2 = lines[i + 2]?.trim() ?? "";
      if (CATEGORY_RE.test(n1) || CATEGORY_BARE_RE.test(n1) || CATEGORY_RE.test(n2) || CATEGORY_BARE_RE.test(n2)) starts.push(i);
    }
  }
  if (!starts.length) return { preamble: "", scripts: [text] };
  const preamble = lines.slice(0, starts[0]).join("\n").trim();
  const scripts = starts.map((s, idx) => lines.slice(s, starts[idx + 1] ?? lines.length).join("\n").trim());
  return { preamble, scripts };
}

// ---------------------------------------------------------------------------
// Spoken-time estimate (manifest §4.3 rule)
// ---------------------------------------------------------------------------

export type SpokenEstimate = {
  words: number;
  seconds: number;
  wordsPerSec: number;
  breakdown: { hook: number; points: number[]; extra: number; close: number };
  /** True when the estimate falls inside the policy target. */
  inTarget: boolean;
  target: readonly [number, number];
};

function allSpokenText(script: CanonicalScript): string {
  return [script.hook?.text ?? "", ...script.points.map((p) => p.text), ...script.extraSpokenBlocks.map((b) => b.text), script.close?.text ?? ""].join("\n");
}

export function estimateSpokenSeconds(script: CanonicalScript, wordsPerSec: number = GENERATION_POLICY.timing.wordsPerSec): SpokenEstimate {
  const hook = countSpokenWords(script.hook?.text ?? "");
  const points = script.points.map((p) => countSpokenWords(p.text));
  const extra = script.extraSpokenBlocks.reduce((n, b) => n + countSpokenWords(b.text), 0);
  const close = countSpokenWords(script.close?.text ?? "");
  const words = hook + points.reduce((a, b) => a + b, 0) + extra + close;
  const seconds = Math.round(words / wordsPerSec);
  const target = GENERATION_POLICY.timing.targetSec;
  return { words, seconds, wordsPerSec, breakdown: { hook, points, extra, close }, inTarget: seconds >= target[0] && seconds <= target[1], target };
}

// ---------------------------------------------------------------------------
// Renderer — the canonical presentation (spec §27), exactly
// ---------------------------------------------------------------------------

export type RenderScriptOptions = {
  /** Include the internal fields under a divider (staff view). Default false = client-facing lines only. */
  includeInternal?: boolean;
};

function pointLabel(p: TalkingPoint, i: number): string {
  const spec = p.role ? TALKING_POINT_ROLE_SPECS.find((s) => s.role === p.role) : null;
  return spec ? `Talking Point ${i + 1}: ${spec.label}` : `Talking Point ${i + 1}`;
}

export function renderScript(script: CanonicalScript, opts: RenderScriptOptions = {}): string {
  const out: string[] = [];
  out.push(script.title || "(untitled)");
  out.push(`Category: ${script.pillarRef?.pillarName ?? script.pillarRef?.categoryAsDelivered ?? "(no pillar linked)"}`);
  out.push("HOOK");
  out.push(...(script.hook?.lines.length ? script.hook.lines : ["(no hook)"]));
  script.points.forEach((p, i) => {
    out.push(pointLabel(p, i));
    out.push(...(p.lines.length ? p.lines : ["(empty)"]));
  });
  for (const extra of script.extraSpokenBlocks) {
    out.push(extra.kind === "re-hook" ? "Re-hook (as delivered)" : extra.kind === "payoff" ? "Payoff (as delivered)" : extra.label ?? "(block)");
    out.push(...extra.lines);
  }
  out.push("Close / Call to action");
  out.push(...(script.close?.lines.length ? script.close.lines : ["(no close)"]));
  if (script.captionCta) {
    out.push("Optional Caption CTA");
    out.push(...script.captionCta.split("\n"));
  }
  if (opts.includeInternal) {
    const it = script.internal;
    const extras: string[] = [];
    if (it.goal) extras.push(`Goal: ${it.goal}`);
    if (it.creativeDirection) extras.push(`Creative direction: ${it.creativeDirection}`);
    if (it.filmingNotes) extras.push(`Filming notes: ${it.filmingNotes}`);
    for (const n of it.productionNotes) extras.push(`Production note: ${n}`);
    if (it.placeholders.length) extras.push(`Placeholders: ${it.placeholders.join(", ")}`);
    if (it.speakerLabels.length) extras.push(`Speakers: ${it.speakerLabels.join(", ")}`);
    if (it.durationStated) extras.push(`Duration stated on the source page: ${it.durationStated}`);
    if (it.props) extras.push(`Props: ${it.props}`);
    if (it.contentPillarCheck) for (const [k, v] of Object.entries(it.contentPillarCheck)) extras.push(`${k}: ${v}`);
    if (script.gaps.length) for (const g of script.gaps) extras.push(`GAP (${g.kind}${g.field ? ` · ${g.field}` : ""}): ${g.text}${g.question ? ` → ${g.question}` : ""}`);
    if (extras.length) out.push("", "--- internal (not client-visible) ---", ...extras);
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Generator output → CanonicalScript (the JSON shape prompts.ts asks for)
// ---------------------------------------------------------------------------

export type GeneratedScriptJson = {
  title: string;
  category: string;
  pillarId?: string | null;
  hook: string;
  points: { role: TalkingPointRole | string; text: string }[];
  close: string;
  captionCta?: string | null;
  filmingNotes?: string | null;
  contentPillarCheck?: Partial<Record<QualityDimension, string>> | null;
  sourceExcerpts?: string[];
  alternateHooks?: string[];
  gaps?: Gap[];
};

export function scriptFromGeneratorOutput(json: GeneratedScriptJson, stamp: PolicyStamp | null, clientId: string | null = null): CanonicalScript {
  const internal = emptyInternal();
  internal.filmingNotes = json.filmingNotes ?? null;
  internal.contentPillarCheck = json.contentPillarCheck ?? null;
  internal.sourceExcerpts = json.sourceExcerpts ?? [];
  internal.alternateHooks = json.alternateHooks ?? [];
  const pillarRef = pillarRefFromCategory(json.category ?? "");
  pillarRef.pillarId = json.pillarId ?? null;
  const points: TalkingPoint[] = (json.points ?? []).map((p, i) => {
    const role = TALKING_POINT_ROLES.includes(p.role as TalkingPointRole) ? (p.role as TalkingPointRole) : roleFromLabel(String(p.role));
    return { ...makeBlock(p.text ?? ""), index: i + 1, role, roleSource: role ? "generated" : null };
  });
  const script: CanonicalScript = {
    title: json.title ?? "",
    titleAsDelivered: null,
    number: null,
    pillarRef: pillarRef.categoryAsDelivered ? pillarRef : null,
    hook: json.hook ? makeBlock(json.hook) : null,
    points,
    extraSpokenBlocks: [],
    close: json.close ? makeBlock(json.close) : null,
    captionCta: json.captionCta ?? null,
    clientId,
    internal,
    gaps: [...(json.gaps ?? [])],
    stamp,
    parseWarnings: [],
  };
  const found = new Set<string>();
  for (const ph of allSpokenText(script).match(PLACEHOLDER_RE) ?? []) found.add(ph);
  internal.placeholders = [...found];
  for (const ph of internal.placeholders) {
    if (!script.gaps.some((g) => g.kind === "placeholder" && g.text.includes(ph))) {
      script.gaps.push(makeGap("placeholder", `Placeholder ${ph} must be supplied before filming.`, { field: "spoken", question: `What is the value for ${ph}?` }));
    }
  }
  return script;
}

// ---------------------------------------------------------------------------
// Validator — NEW generation only. Deterministic. The archive is never run
// through this to be "fixed"; when it is run for a report, the findings are
// the report ("this 2026-04 script has four points"), not a rejection.
// ---------------------------------------------------------------------------

export type ScriptValidation = {
  /** No blocking findings. */
  ok: boolean;
  findings: Finding[];
  gaps: Gap[];
  estimate: SpokenEstimate;
};

export type ValidateScriptOptions = {
  /** Require a pillar link (default true; spec gate 7). */
  requirePillar?: boolean;
};

// Greeting shapes. BLOCK = the viewer is being greeted or the agent introduced:
// "Hi, …" / "Hello, …" / "Hi there|guys|everyone…" / "Hey guys|everyone…" /
// "Welcome to|back…" / "Good morning…" / "Hi I'm…". A greeting word followed by
// a capitalised word ("Hello Kitty wallpaper…", "Hey Sarah, …") is only
// PROBABLY a greeting → warn. A bare "Hey." / "Hey, here's the thing." is a
// conversational interjection → warn. "Hi-rise", "Welcome mats", "Hello" as a
// noun mid-sentence never match.
const GREETING_BLOCK_RE =
  /^(?:(?:hi|hello)\s*[,!]|hey\s*!|(?:hi|hello|hey)\s+(?:there|guys|everyone|everybody|all|folks|friends|y['’]?all|i['’]m|i am|my name is)\b|welcome\s+(?:to|back)\b|good\s+(?:morning|afternoon|evening)\b|what['’]?s\s+up\b)/i;
const GREETING_WARN_RE = /^(?:[Hh](?:i|ello|ey)\s+[A-Z][a-z]+|[Hh]ey\s*[,.:;—–-]|[Hh]ey\s+(?:so|here|listen|look|quick)\b)/;
// Self-introduction: "I'm <Name>" / "I am <Name>" / "My name is …". The prefix is
// case-insensitive (a real hook starts with a capital I / My); the following
// token must be a capitalised name so "I'm not going to sugarcoat this" stays legal.
const INTRO_PREFIX_RE = /^(i['’]m|i am|my name is)\s+(\S+)/i;

function greetingShape(text: string): "block" | "warn" | null {
  const t = text.replace(/^[“"'‘]+/, "");
  if (GREETING_BLOCK_RE.test(t)) return "block";
  if (isSelfIntro(t)) return "block";
  if (GREETING_WARN_RE.test(t)) return "warn";
  return null;
}

function isSelfIntro(text: string): boolean {
  const m = INTRO_PREFIX_RE.exec(text);
  if (!m) return false;
  if (/^my name is/i.test(m[1])) return true;
  const next = m[2].replace(/[,.!?:;]+$/, "");
  return /^[A-Z][a-z]+$/.test(next) && !/^(Not|Going|Here|Just|Sorry|About|Done|Tired|Sure|Telling)$/.test(next);
}

export function validateNewScript(script: CanonicalScript, opts: ValidateScriptOptions = {}): ScriptValidation {
  const policy = GENERATION_POLICY;
  const findings: Finding[] = [];
  const gaps: Gap[] = [...script.gaps];
  const push = (code: string, severity: Finding["severity"], message: string, path?: string, measured?: Finding["measured"]) =>
    findings.push({ code, severity, message, path, measured });

  if (!script.title.trim()) push("title.missing", "block", "The script has no title.", "title");

  // Hook
  const hookText = script.hook?.text.trim() ?? "";
  if (!hookText) push("hook.missing", "block", "Every script must begin with a strong hook — none present.", "hook");
  else {
    const opener = hookText.replace(/^[“"'‘]+/, "");
    const banned = policy.hooks.bannedOpeners.find((b) => opener.toLowerCase().startsWith(b.toLowerCase()));
    const shape = greetingShape(opener);
    if (banned) push("hook.banned-opener", "block", `The hook opens with “${banned}…” — never begin with a greeting or an introduction.`, "hook", { opener: banned });
    else if (shape === "block") push("hook.banned-opener", "block", "The hook opens with a greeting or self-introduction.", "hook", { opener: opener.split(/\s+/).slice(0, 3).join(" ") });
    else if (shape === "warn") push("hook.possible-greeting", "warn", "The hook may open with a greeting or an aside (“Hey…”) — confirm it is a real hook.", "hook", { opener: opener.split(/\s+/).slice(0, 3).join(" ") });
    const weak = policy.hooks.weakPatterns.find((w) => opener.toLowerCase().startsWith(w.toLowerCase()));
    if (weak) push("hook.weak-pattern", "warn", `The hook uses a weak shape (“${weak}…”).`, "hook", { pattern: weak });
    for (const w of policy.hooks.advisory.bannedWords) {
      if (hookText.toLowerCase().includes(w.toLowerCase())) push("hook.advisory-word", "info", `Advisory: the hook contains “${w}” (listing-reel banned list; warn only).`, "hook", { word: w });
    }
  }

  // Greeting / intro anywhere in the spoken body (spec: "No greetings or introductions").
  script.points.forEach((p, i) => {
    const shape = greetingShape(p.text.trim());
    if (shape === "block") push("intro.greeting", "block", `Talking point ${i + 1} contains a greeting or self-introduction.`, `points[${i}]`);
    else if (shape === "warn") push("intro.possible-greeting", "warn", `Talking point ${i + 1} may open with a greeting or an aside — confirm.`, `points[${i}]`);
  });

  // Exactly three roled points, in order.
  const n = script.points.length;
  if (n !== policy.talkingPoints.count) {
    push("talking-points.count", "block", `Exactly ${policy.talkingPoints.count} talking points are required; this script has ${n}.`, "points", { count: n, required: policy.talkingPoints.count });
  }
  if (script.extraSpokenBlocks.length) {
    push("talking-points.extra-blocks", "block", `Separate spoken ${script.extraSpokenBlocks.map((b) => b.kind).join(" / ")} blocks are an archive format; fold them into the three points.`, "extraSpokenBlocks", {
      count: script.extraSpokenBlocks.length,
    });
  }
  const roles = script.points.map((p) => p.role);
  const rolesOk = roles.every((r, i) => r === policy.talkingPoints.roles[i]);
  // Roles can never be right when the count is wrong — one finding, not two.
  if (n === policy.talkingPoints.count && !rolesOk) {
    const missing = script.points.filter((p) => !p.role).length;
    push(
      "talking-points.roles",
      "block",
      missing ? `${missing} talking point${missing === 1 ? " has" : "s have"} no role; roles must be Re-hook, Build up, Payoff in that order.` : `Talking-point roles are ${roles.map((r) => r ?? "none").join(", ")}; required order is Re-hook, Build up, Payoff.`,
      "points",
      { roles: roles.map((r) => r ?? "none").join(",") },
    );
  }
  script.points.forEach((p, i) => {
    if (!p.text.trim()) push("talking-points.empty", "block", `Talking point ${i + 1} is empty.`, `points[${i}]`);
  });

  // Close
  if (!script.close?.text.trim()) push("close.missing", "block", "Every script must end with a strong close — none present.", "close");

  // Timing — a finding with the measured seconds. Enforcement mode (block vs
  // warn) is Jordan's open question Q1; the target itself is settled at 20–30 s.
  const estimate = estimateSpokenSeconds(script);
  if (!estimate.inTarget) {
    const [lo, hi] = estimate.target;
    push(
      "timing.out-of-range",
      "warn",
      `Spoken estimate ≈${estimate.seconds} s (${estimate.words} words at ${estimate.wordsPerSec} w/s) is ${estimate.seconds < lo ? "under" : "over"} the ${lo}–${hi} s target. Tighten rather than force rapid delivery.`,
      "spoken",
      { seconds: estimate.seconds, words: estimate.words, targetLo: lo, targetHi: hi },
    );
  }

  // Pillar linkage (gate 7).
  if (opts.requirePillar !== false) {
    if (!script.pillarRef || (!script.pillarRef.pillarName && !script.pillarRef.pillarId)) push("pillar.missing", "block", "The script is not linked to an approved content pillar.", "pillarRef");
    else if (!script.pillarRef.pillarId) push("pillar.unmapped", "info", `Category “${script.pillarRef.categoryAsDelivered}” has no pillar id yet — map it on import.`, "pillarRef.pillarId");
  }

  // Unsupported-claim gaps the generator emitted stay visible; note them.
  for (const g of gaps) {
    if (g.kind === "unsupported-claim") push("gap.unsupported-claim", "warn", `Unsupported claim flagged in ${g.field ?? "the script"}: ${g.text}`, g.field ?? undefined);
    else if (g.kind === "placeholder") push("gap.placeholder", "info", g.text, g.field ?? undefined);
    else push(`gap.${g.kind}`, "info", g.text, g.field ?? undefined);
  }

  return { ok: !findings.some((f) => f.severity === "block"), findings, gaps, estimate };
}
