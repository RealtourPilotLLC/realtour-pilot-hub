"use client";

import { useState } from "react";
import { AvatarInitials } from "@/components/ui/Avatar";

// The photo half of <Avatar>. A client component only because an <img> that
// 404s (Zillow rotates its static URLs) needs onError to fall back to the
// initials — everything else about the avatar stays server-rendered.
export function AvatarPhoto({
  name,
  src,
  color,
  size,
  title,
}: {
  name: string;
  src: string;
  color?: string;
  size: number;
  title?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) return <AvatarInitials name={name} color={color} size={size} title={title} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote host varies (Zillow static), no next/image domain list
    <img
      src={src}
      alt={name}
      title={title ?? name}
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  );
}
