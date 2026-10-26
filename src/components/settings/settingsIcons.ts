import { CalendarCheck, Clapperboard, Clock, MessageSquareText, Plug, Users, Wallet, type LucideIcon } from "lucide-react";
import type { SettingsGroupId } from "@/lib/readiness";

/** One icon per Settings section, shared by the menu, the overview tiles and the section headings. */
export const SETTINGS_GROUP_ICONS: Record<SettingsGroupId, LucideIcon> = {
  team: Users,
  scheduling: Clock,
  production: Clapperboard,
  program: CalendarCheck,
  comms: MessageSquareText,
  integrations: Plug,
  financial: Wallet,
};
