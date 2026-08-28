// A script rendered the way it deserves (Jordan: "bold titles and subtitles")
// — the house sections (HOOK / TALKING POINT n / CALLBACK / CTA) become
// styled subtitles, the Category line becomes a chip, the breath-lines keep
// their rhythm. Pure presentation; the stored text never changes.
// NB: no case-negated classes here — [^a-z] under /i rejects uppercase too
// (review finding: "TALKING POINT 1 - RE-HOOK" failed to match).
const SECTION_RE = /^(HOOK|TALKING POINT\s*\d+(?:\s*[-–—][\w'’ /-]*)?|CALLBACK(?:\s*\/\s*CTA)?|CTA|CALL TO ACTION|OUTRO|INTRO)\s*:?\s*$/i;

export function ScriptBody({ body, size = "sm" }: { body: string; size?: "sm" | "xs" }) {
  const lines = body.split("\n");
  const blocks: { kind: "category" | "section" | "text"; text: string }[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^Category:\s*/i.test(line.trim())) {
      blocks.push({ kind: "category", text: line.trim().replace(/^Category:\s*/i, "") });
    } else if (SECTION_RE.test(line.trim())) {
      blocks.push({ kind: "section", text: line.trim().replace(/:$/, "") });
    } else {
      blocks.push({ kind: "text", text: line });
    }
  }
  const textCls = size === "xs" ? "text-xs" : "text-sm";
  return (
    <div className="mt-2">
      {blocks.map((b, i) =>
        b.kind === "category" ? (
          <span key={i} className="mb-2 inline-block rounded-md bg-brand-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
            {b.text}
          </span>
        ) : b.kind === "section" ? (
          <div key={i} className="mb-1 mt-3 text-[11px] font-bold uppercase tracking-widest text-brand first:mt-0">
            {b.text}
          </div>
        ) : b.text.trim() === "" ? (
          <div key={i} className="h-1.5" />
        ) : (
          <p key={i} className={`${textCls} leading-relaxed text-foreground/90`}>{b.text}</p>
        ),
      )}
    </div>
  );
}
