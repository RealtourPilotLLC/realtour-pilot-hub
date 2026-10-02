// @drill-run: conditions=none
import { protectUploadWorkspace } from "../../src/lib/uploadNavigation";
import { makeChecker } from "./_harness";

const c = makeChecker();
class Surface {
  listeners = new Map<string, { callback: (e: unknown) => void; capture: boolean }>();
  addEventListener(name: string, callback: (e: unknown) => void, capture = false) { this.listeners.set(name, { callback, capture }); }
  removeEventListener(name: string) { this.listeners.delete(name); }
}
const win = new Surface(), doc = new Surface();
const selected = { output: "video-16", file: "exact-export-v3.mp4", sent: 0 };
const location = { href: "http://fixture.test/edit/job?output=video-16" };
const state = { selected: "video-16", router: "existing-router-state" };
let restoredState: unknown, blocked = 0;
const history = { state, pushState(next: unknown, _title: string, url: string) { restoredState = next; location.href = url; } };
Object.assign(win, { location, history });
const cleanup = protectUploadWorkspace(() => blocked++, { window: win as unknown as Window, document: doc as unknown as Document });
let stopped = false, prevented = false;
location.href = "http://fixture.test/edit/job?output=video-15";
win.listeners.get("popstate")!.callback({ stopImmediatePropagation() { stopped = true; } });
c.ok("Back restores the exact selected workspace and router state without unmounting its file", location.href.endsWith("output=video-16") && restoredState === state && selected.output === "video-16" && selected.file === "exact-export-v3.mp4" && stopped && blocked === 1 && selected.sent === 0);
c.ok("history guard captures before normal router traversal listeners", win.listeners.get("popstate")!.capture);
const click = (href: string, target = "") => doc.listeners.get("click")!.callback({ target: { closest: () => ({ target, getAttribute: () => href }) }, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
prevented = false; click("/edit/job?output=video-1");
c.ok("switching videos is refused while the file/check is still mounted", prevented && blocked === 2 && selected.sent === 0);
prevented = false; click("#instructions"); click("https://dropbox.example.test/files", "_blank");
c.ok("instruction anchors and separate footage tabs remain usable", !prevented && blocked === 2);
prevented = false; win.listeners.get("beforeunload")!.callback({ preventDefault() { prevented = true; }, returnValue: undefined });
c.ok("leaving or reloading requests browser confirmation", prevented);
cleanup();
c.ok("completing or cancelling restores normal navigation", win.listeners.size === 0 && doc.listeners.size === 0 && selected.sent === 0);
c.summary();
