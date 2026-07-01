"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, X } from "lucide-react";
import { exitViewAs } from "@/app/users/actions";

// Persistent banner shown while an owner is previewing another user's view.
// Every mutation is already blocked server-side; this makes the state obvious and
// gives a one-click way out.
export function ViewAsBanner({ name }: { name: string | null }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const exit = () =>
    start(async () => {
      await exitViewAs();
      router.push("/users");
      router.refresh();
    });
  return (
    <div
      className="flex items-center justify-center gap-3 px-4 py-1.5 text-center text-xs font-medium"
      style={{ background: "#f59e0b", color: "#1a1206" }}
    >
      <Eye className="size-3.5 shrink-0" />
      <span>
        Viewing as <b>{name ?? "user"}</b> — read-only, changes are disabled.
      </span>
      <button
        onClick={exit}
        disabled={pending}
        className="inline-flex items-center gap-1 rounded-md bg-black/15 px-2 py-0.5 font-semibold hover:bg-black/25 disabled:opacity-60"
      >
        <X className="size-3" /> {pending ? "Exiting…" : "Exit preview"}
      </button>
    </div>
  );
}
