import { PageHeader } from "@/components/PageHeader";
import { StyleGuideBody } from "./guide";

// The full Style Guide page (Creative nav → "Style Guide"). All content lives
// in ./guide.tsx, shared with the /embed route the Editor Queue's floating
// window iframes. Daily ISR — see the note atop guide.tsx.
export const revalidate = 86400;

export default async function VideoStylesPage() {
  return (
    <div>
      <PageHeader
        eyebrow="Editor reference"
        title="Video Style Guide"
        subtitle="What you're editing, what it should look like, and how long it should take"
      />
      <StyleGuideBody />
    </div>
  );
}
