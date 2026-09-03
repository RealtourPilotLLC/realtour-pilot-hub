import { initials } from "@/lib/utils";
import { AvatarPhoto } from "@/components/ui/AvatarPhoto";

// One avatar for people everywhere. Pass `src` (a client's Aryeo headshot,
// Client.avatarUrl) and it shows the photo; without one — or if the photo
// fails to load — it falls back to the initials disc it always drew.
export function Avatar({
  name,
  src,
  color = "#6366f1",
  size = 28,
  title,
}: {
  name: string;
  src?: string | null;
  color?: string;
  size?: number;
  title?: string;
}) {
  if (src) return <AvatarPhoto name={name} src={src} color={color} size={size} title={title} />;
  return <AvatarInitials name={name} color={color} size={size} title={title} />;
}

export function AvatarInitials({
  name,
  color = "#6366f1",
  size = 28,
  title,
}: {
  name: string;
  color?: string;
  size?: number;
  title?: string;
}) {
  return (
    <span
      title={title ?? name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        backgroundColor: color,
        width: size,
        height: size,
        fontSize: size * 0.4,
      }}
    >
      {initials(name)}
    </span>
  );
}
