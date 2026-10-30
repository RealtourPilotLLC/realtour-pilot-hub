// The in-house video editors a picker offers (Oct 30 2026). The page reads
// them from the roster (lib/editors videoEditorChoices: Kim, Jhon Mark and
// everyone onboarded on People) and passes them down as a prop, because the
// client's copy of lib/editors only knows the built-in names. A picker given
// none still offers the two built-in editors.
export type VideoEditorChoice = { key: string; name: string };

export const BUILT_IN_VIDEO_EDITORS: VideoEditorChoice[] = [
  { key: "john", name: "Jhon Mark" },
  { key: "kim", name: "Kim" },
];
