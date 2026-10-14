"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { photoSrc, type DerivSize } from "./format";

// ---------------------------------------------------------------------------
// One photo from the hub's staff-only derivative route
// (/api/photo-delivery/img/<photoId>/<size>?v=<contentHash>). Most galleries
// are read from the Aryeo listing before delivery (PhotoAsset.sourceKind
// ARYEO), so when the route has nothing for a photo yet the Aryeo CDN copy is
// the fallback; when neither loads, a plain placeholder says so instead of a
// broken-image icon.
// ---------------------------------------------------------------------------

export function PhotoImg({
  photoId,
  hash,
  fallbackUrl,
  size,
  alt,
  className,
  versionId,
  large = false,
  eager = false,
  onLoad,
}: {
  photoId: string;
  hash: string | null;
  fallbackUrl?: string | null;
  size: DerivSize;
  alt: string;
  className?: string;
  /** A past PhotoVersion (review mode's original vs current). */
  versionId?: string | null;
  /** Big views: offer qc1024 and qc2048 and let the browser pick. */
  large?: boolean;
  eager?: boolean;
  onLoad?: () => void;
}) {
  const primary = photoSrc(photoId, size, hash, versionId);
  // The failure is remembered per source, so a new photo (or version) gets a fresh try.
  const [failed, setFailed] = useState<{ src: string; stage: "fallback" | "none" } | null>(null);
  const stage = failed?.src === primary ? failed.stage : null;
  const src = stage === "fallback" && fallbackUrl && !versionId ? fallbackUrl : primary;

  if (stage === "none" || (stage === "fallback" && (!fallbackUrl || versionId))) {
    return (
      <span role="img" aria-label={`${alt} (preview not available yet)`} className={cn("flex items-center justify-center bg-surface-2 text-muted", className)}>
        <ImageOff aria-hidden className="size-5" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={src}
      src={src}
      srcSet={large && stage === null ? `${photoSrc(photoId, "qc1024", hash, versionId)} 1024w, ${photoSrc(photoId, "qc2048", hash, versionId)} 2048w` : undefined}
      sizes={large && stage === null ? "(max-width: 1024px) 100vw, 70vw" : undefined}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      onLoad={onLoad}
      onError={() => setFailed({ src: primary, stage: stage === null ? "fallback" : "none" })}
      className={className}
    />
  );
}
