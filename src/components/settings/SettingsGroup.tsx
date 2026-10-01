import type { ReactNode } from "react";
import type { SettingsGroupDef } from "@/lib/settingsNavigation";
import { SettingsGroupDisclosure } from "@/components/settings/SettingsGroupDisclosure";

export { SETTINGS_GROUPS, SETTINGS_CARD_KEYS, SETTINGS_LAYOUT, settingsGroupsFor } from "@/lib/settingsNavigation";
export type { SettingsGroupDef, SettingsCardKey } from "@/lib/settingsNavigation";

export function SettingsGroup({ group, snapshot, children }: { group: SettingsGroupDef; snapshot?: ReactNode; children: ReactNode }) {
  return <SettingsGroupDisclosure group={group} snapshot={snapshot}>{children}</SettingsGroupDisclosure>;
}
