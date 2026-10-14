// Oct 14 2026, Jordan: "Right now, the photos from auto HDR in the hub are not
// displaying. Please make sure they display." Turns on display.ts: a finished
// hub shoot's photos are downloaded once (the delivery credit) so they show.
import { savePhotoDeliverySettings } from "@/lib/photoDelivery/settings";
savePhotoDeliverySettings({ showAutohdrPhotos: true }, "claude (for Jordan, Oct 14)").then((s) => { console.log({ showAutohdrPhotos: s.showAutohdrPhotos }); process.exit(0); });
