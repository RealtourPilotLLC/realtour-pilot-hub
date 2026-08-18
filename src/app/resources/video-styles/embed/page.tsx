import { StyleGuideBody } from "../guide";

// Bare Style Guide for the Editor Queue's floating window (an iframe points
// here). No sidebar/chrome — Shell.tsx lists this path as bare — and no page
// header: the window's own title bar carries the name. Same auth as the full
// page: middleware resolves /resources/* to the `resources` PageKey, which
// every role has.
export const revalidate = 86400;

export default async function StyleGuideEmbedPage() {
  return <StyleGuideBody embed />;
}
