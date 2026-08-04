"use client";

import { useLayoutEffect, useRef, useCallback, type Ref, type TextareaHTMLAttributes } from "react";

// A textarea that grows with what you type.
//
// The old boxes were fixed at one to four rows, so anything longer than a
// sentence scrolled inside a slot too small to read it — you couldn't see what
// you'd written while writing it. Kyle filed exactly this from Ask the Hub,
// where the composer was `rows={1}` AND `resize-none`: one line, no handle, no
// growth.
//
// Grows to `maxRows` and only then scrolls, so a long paste can't push the send
// button off the screen. Text wraps as normal — the wrapping was never broken,
// the height was.

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Height floor, in rows. */
  minRows?: number;
  /** Height ceiling before it starts scrolling instead of growing. */
  maxRows?: number;
  /** Callers that drive the caret themselves (the @-mention surfaces) need the node. */
  ref?: Ref<HTMLTextAreaElement>;
};

export function AutoTextarea({ minRows = 1, maxRows = 12, className = "", value, ref: forwarded, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Keep our own handle for measuring AND hand the node to the caller, so
  // @-mention insertion and focus() still work through the wrapper.
  const attach = useCallback(
    (el: HTMLTextAreaElement | null) => {
      ref.current = el;
      if (typeof forwarded === "function") forwarded(el);
      else if (forwarded) (forwarded as { current: HTMLTextAreaElement | null }).current = el;
    },
    [forwarded],
  );

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Must collapse first: scrollHeight never reports LESS than the current
    // height, so without this the box grows and never shrinks back.
    el.style.height = "auto";
    const cs = window.getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 20;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const min = line * minRows + pad + border;
    const max = line * maxRows + pad + border;
    const next = Math.min(Math.max(el.scrollHeight + border, min), max);
    el.style.height = `${next}px`;
    // Only show a scrollbar once it has actually stopped growing.
    el.style.overflowY = el.scrollHeight + border > max ? "auto" : "hidden";
  }, [minRows, maxRows]);

  // Runs on every value change, so it also shrinks back when the field is
  // cleared after sending — not just when the user types.
  useLayoutEffect(resize, [resize, value]);

  return (
    <textarea
      ref={attach}
      value={value}
      onInput={resize}
      rows={minRows}
      className={`resize-none ${className}`}
      {...rest}
    />
  );
}
