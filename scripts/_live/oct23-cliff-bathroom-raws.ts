// Live one-off (Oct 23 2026): Harrison's Oct 23 visit raws for 615 Cliff Ln landed in a
// new "Bathroom Photos" folder beside 01-RAW-Photos, which the photo intake never reads.
// Moved (not copied) INTO 01-RAW-Photos as a subfolder; the intake lists it recursively.
import { dropboxMoveFolder } from "@/lib/integrations/dropbox";
const BASE = "/AutoHDR/2026/Q4/October/615 Cliff Ln (Alex  Ercole Stackhouse)";
(async () => {
  console.log(await dropboxMoveFolder(`${BASE}/Bathroom Photos`, `${BASE}/01-RAW-Photos/Bathroom Photos`));
})();
