// Portal body-text formatter (Jordan: "parsed and formatted really nicely so
// it's legible and not just crammed in there"). Pure presentation: blank
// lines split paragraphs, dash/bullet/numbered lines become real lists,
// short ALL-CAPS or colon-ended lead lines become small subheadings.
const BULLET_RE = /^\s*(?:[-•*·]|\d{1,2}[.)])\s+/;
const HEADING_RE = /^[A-Z][A-Za-z0-9 &/'-]{2,48}:$/;

export function PortalRichText({ text, size = "sm" }: { text: string; size?: "sm" | "xs" }) {
  const cls = size === "xs" ? "text-xs" : "text-sm";
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return (
    <div className="mt-2 space-y-2.5">
      {blocks.map((block, i) => {
        const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
        const bullets = lines.filter((l) => BULLET_RE.test(l));
        // A block that's mostly bullets renders as a list; stray lead lines
        // above the bullets become the list's intro.
        if (bullets.length >= 2 && bullets.length >= lines.length - 1) {
          const intro = lines.find((l) => !BULLET_RE.test(l));
          return (
            <div key={i}>
              {intro && <p className={`${cls} mb-1 leading-relaxed text-foreground/85`}>{intro}</p>}
              <ul className="space-y-1 pl-1">
                {bullets.map((l, j) => (
                  <li key={j} className={`${cls} flex gap-2 leading-relaxed text-foreground/85`}>
                    <span className="mt-0.5 text-brand">·</span>
                    <span>{l.replace(BULLET_RE, "")}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        }
        if (lines.length === 1 && HEADING_RE.test(lines[0])) {
          return <div key={i} className="pt-1 text-[11px] font-bold uppercase tracking-widest text-muted-2">{lines[0].replace(/:$/, "")}</div>;
        }
        // Multi-line prose: each line its own breathable paragraph line.
        return (
          <div key={i} className="space-y-1">
            {lines.map((l, j) =>
              HEADING_RE.test(l) ? (
                <div key={j} className="pt-1 text-[11px] font-bold uppercase tracking-widest text-muted-2">{l.replace(/:$/, "")}</div>
              ) : (
                <p key={j} className={`${cls} leading-relaxed text-foreground/85`}>{l.replace(BULLET_RE, "")}</p>
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}
