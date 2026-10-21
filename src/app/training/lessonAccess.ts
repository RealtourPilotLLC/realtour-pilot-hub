// Which Vol II courses creatives (photographers/editors) may see. Jordan's rule:
// they get everything CREATIVE — shooting, filming, editing, scripting — and
// none of the business side (sales, pricing, systems, growth, coaching replays).
// Vol I "Agent on Camera" is entirely creative and always visible. This is an
// ALLOWLIST on purpose: a newly-ingested business course is hidden by default.
// The Hub's KnowledgeItem chunks for the excluded courses are minRole ADMIN, so
// Ask-the-Hub matches this page.
//
// Its own module (Oct 20 2026) because two readers now apply it: the page's
// list and the action that loads one lesson's text when it is opened.
export const CREATIVE_VOL2_COURSES = new Set([
  "AI Editing",
  "Editing",
  "Scripting",
  "Shooting",
  "Viral Editing Masterclass (2024)",
  "Viral Editing Masterclass (2025)",
]);

export function creativeMaySee(lesson: { volume: string; course: string }): boolean {
  return lesson.volume === "Agent on Camera" || CREATIVE_VOL2_COURSES.has(lesson.course);
}
