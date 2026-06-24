// The fixed image-flag tag vocabulary — also the training labels for the
// later automated QA/editing model. Kept in a plain module (not the "use server"
// actions file, which may only export async functions) so both the server action
// and the client gallery can import it.
export const IMAGE_FLAG_TAGS = [
  "Item Removal",
  "Perspective Corrections",
  "Color/Lighting",
  "Mirror Reflection",
  "Sign in the Yard",
  "AI Error",
] as const;
