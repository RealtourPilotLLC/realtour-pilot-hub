"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import {
  MessageSquarePlus, X, Bug, Sparkles, MessageSquare, Camera, Loader2, Send, Check, Trash2, Paperclip,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { submitPlatformFeedback } from "@/app/feedback/actions";

const KINDS = [
  { key: "feature", label: "Idea", icon: Sparkles },
  { key: "bug", label: "Bug", icon: Bug },
  { key: "feedback", label: "Note", icon: MessageSquare },
];

// Floating feedback launcher shown on every page (mounted in the Shell). Lets
// Kyle (or anyone) fire off a request/bug with an optional screenshot — either
// auto-captured from the current page or pasted/dropped/uploaded — which lands
// on the /feedback review board for Jordan to approve.
export function FeedbackWidget() {
  const pathname = usePathname();
  // The photographer shoot screen has a sticky bottom action bar ("Mark shoot
  // complete"); lift the launcher so it never sits on top of that button.
  const bottom = /^\/shoot\/[^/]+$/.test(pathname) ? "bottom-20" : "bottom-4";
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("feature");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [name, setName] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Remember the submitter's name between submissions.
  useEffect(() => {
    try { const n = localStorage.getItem("fbName"); if (n) setName(n); } catch {}
  }, []);

  // Downscale any image to a compact JPEG data URL so the row stays small.
  const toCompactDataUrl = (src: string): Promise<string> =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) return resolve(src);
        const max = 1600;
        const scale = Math.min(1, max / Math.max(w, h));
        const c = document.createElement("canvas");
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        const ctx = c.getContext("2d");
        if (!ctx) return resolve(src);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.72));
      };
      img.onerror = () => resolve(src);
      img.src = src;
    });

  const ingestFile = async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = async () => setShot(await toCompactDataUrl(String(reader.result)));
    reader.readAsDataURL(file);
  };

  // Capture the current page (hides the widget panel first so it isn't in shot).
  const capturePage = async () => {
    setErr(null);
    setCapturing(true);
    setOpen(false);
    try {
      await new Promise((r) => setTimeout(r, 250)); // let the panel close
      const { default: html2canvas } = await import("html2canvas-pro");
      const target = (document.scrollingElement as HTMLElement) || document.body;
      const canvas = await html2canvas(target, {
        useCORS: true,
        backgroundColor: getComputedStyle(document.body).backgroundColor || "#0b0b0c",
        logging: false,
        scale: 1,
      });
      setShot(await toCompactDataUrl(canvas.toDataURL("image/png")));
    } catch {
      setErr("Couldn't auto-capture this page — paste (⌘/Ctrl+V) or upload a screenshot instead.");
    } finally {
      setCapturing(false);
      setOpen(true);
    }
  };

  // Paste an image straight into the panel (Cmd/Ctrl+V).
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) { e.preventDefault(); ingestFile(file); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [open]);

  const reset = () => { setTitle(""); setBody(""); setShot(null); setErr(null); };

  const submit = () => {
    setErr(null);
    start(async () => {
      try { if (name.trim()) localStorage.setItem("fbName", name.trim()); } catch {}
      const r = await submitPlatformFeedback({
        kind, title, body, submittedBy: name, page: pathname || "the app", screenshot: shot || undefined,
      });
      if (r.ok) {
        setDone(true);
        reset();
        setTimeout(() => { setDone(false); setOpen(false); }, 1800);
      } else setErr(r.message);
    });
  };

  return (
    <>
      {/* Launcher — fixed, clears Leaflet (~1000) and the mobile drawer (1300). */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title="Send feedback or a feature request"
          className={cn("fixed right-4 z-[1400] inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2.5 text-sm font-medium text-white shadow-lg ring-1 ring-black/10 transition-transform hover:scale-105", bottom)}
        >
          <MessageSquarePlus className="size-4" /> Feedback
        </button>
      )}

      {capturing && (
        <div className={cn("fixed right-4 z-[1400] inline-flex items-center gap-2 rounded-full bg-surface px-4 py-2.5 text-sm shadow-lg ring-1 ring-border", bottom)}>
          <Loader2 className="size-4 animate-spin text-brand" /> Capturing…
        </div>
      )}

      {open && (
        <div className={cn("fixed right-4 z-[1400] w-[min(92vw,380px)] rounded-2xl border border-border bg-surface shadow-2xl ring-1 ring-black/10", bottom)}>
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-semibold">Send feedback</span>
            <button onClick={() => setOpen(false)} className="text-muted hover:text-foreground"><X className="size-4" /></button>
          </div>

          <div className="space-y-2.5 p-4">
            <div className="flex gap-1.5">
              {KINDS.map((k) => {
                const Icon = k.icon;
                return (
                  <button
                    key={k.key}
                    onClick={() => setKind(k.key)}
                    className={cn(
                      "inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors",
                      kind === k.key ? "border-brand/40 bg-brand-soft text-brand" : "border-border text-muted hover:bg-surface-2",
                    )}
                  >
                    <Icon className="size-3.5" /> {k.label}
                  </button>
                );
              })}
            </div>

            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === "bug" ? "What's broken?" : "What would you like?"}
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder="Details — and paste a screenshot (⌘/Ctrl+V) if it helps."
              className="w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
            />

            {/* Screenshot controls */}
            {shot ? (
              <div className="relative overflow-hidden rounded-lg border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={shot} alt="screenshot" className="max-h-40 w-full object-cover" />
                <button
                  onClick={() => setShot(null)}
                  className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-1 text-[11px] text-white hover:bg-black/80"
                >
                  <Trash2 className="size-3" /> Remove
                </button>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <button
                  onClick={capturePage}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface-2"
                >
                  <Camera className="size-3.5" /> Capture page
                </button>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface-2"
                >
                  <Paperclip className="size-3.5" /> Upload / paste
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) ingestFile(f); e.target.value = ""; }}
                />
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <button
                onClick={submit}
                disabled={pending || !title.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : done ? <Check className="size-4" /> : <Send className="size-4" />}
                {done ? "Sent" : "Send"}
              </button>
            </div>
            {done && <p className="text-xs text-success">Thanks! Sent to Jordan for review.</p>}
            {err && <p className="text-xs text-danger">{err}</p>}
          </div>
        </div>
      )}
    </>
  );
}
