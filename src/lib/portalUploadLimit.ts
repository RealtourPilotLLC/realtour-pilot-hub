import { TEXT_KYLE } from "@/lib/portalWords";

// ---------------------------------------------------------------------------
// THE PORTAL'S BRAND-FILE SIZE LIMIT, said once (Oct 5 2026).
//
// The upload route promised 25 MB, but the hosting platform refuses any
// request body over about 4.5 MB before the route runs — so a 6 MB logo came
// back as a non-JSON error and the page offered a Retry that could never work.
// The browser now checks the size before sending and says the limit plainly;
// the route checks the same number. Pure: imported by the page and the route.
// ---------------------------------------------------------------------------

export const PORTAL_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const PORTAL_UPLOAD_MAX_LABEL = "4 MB";

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** The refusal for one file, or null when it fits. */
export function portalUploadTooBig(sizeBytes: number): string | null {
  if (sizeBytes <= PORTAL_UPLOAD_MAX_BYTES) return null;
  return `This file is ${mb(sizeBytes)}. Files up to ${PORTAL_UPLOAD_MAX_LABEL} upload here — for anything bigger, ${TEXT_KYLE} and he'll send you a link to drop it in.`;
}
