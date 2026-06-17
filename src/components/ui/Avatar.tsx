import { initials } from "@/lib/utils";

export function Avatar({
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
