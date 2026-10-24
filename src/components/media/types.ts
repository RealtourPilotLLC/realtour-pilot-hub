// What a video tile needs (lib/mediaLibrary MediaVideo, minus the placement).
// Dates arrive already worded by the server, so the client never formats one.
export type MediaVideoView = {
  key: string;
  title: string;
  eyebrow: string | null;
  place: string | null;
  clientId: string | null;
  clientName: string | null;
  projectId: string | null;
  dateText: string | null;
  orientation: "vertical" | "horizontal" | null;
  poster: string | null;
  playSrc: string;
  downloadHref: string;
  durationSec: number | null;
};

export type MediaGroupView = {
  key: string;
  label: string;
  frame: "vertical" | "horizontal";
  items: MediaVideoView[];
};

export const toVideoView = (v: MediaVideoView): MediaVideoView => ({
  key: v.key, title: v.title, eyebrow: v.eyebrow, place: v.place, clientId: v.clientId, clientName: v.clientName, projectId: v.projectId,
  dateText: v.dateText, orientation: v.orientation, poster: v.poster, playSrc: v.playSrc, downloadHref: v.downloadHref, durationSec: v.durationSec,
});
