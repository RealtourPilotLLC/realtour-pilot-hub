// A script rendered the way it deserves (Jordan: "bold titles and subtitles").
//
// U01 (Sep 25 2026): this used to hold its own single regular expression,
// which knew "HOOK" / "TALKING POINT 1 - RE-HOOK" / "CTA" and missed every
// label the house renderer actually writes ("Talking Point 1: Re-hook",
// "Close / Call to action"), so versioned scripts showed their talking points
// and close as plain paragraphs. It is now a thin wrapper over the one shared
// renderer (components/script/ScriptView.tsx), kept so existing callers keep
// their import. New callers use ScriptView directly and pass `parts` when
// they have them.
import { ScriptView, type ScriptViewProps } from "@/components/script/ScriptView";

export function ScriptBody({ body, size = "sm", ...rest }: { body: string; size?: "sm" | "xs" } & Omit<ScriptViewProps, "body" | "size">) {
  return <ScriptView body={body} size={size} {...rest} />;
}
