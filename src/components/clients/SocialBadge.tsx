import { Badge } from "@/components/ui/Badge";
import { PALETTE } from "@/lib/palette";

// Monthly social-content subscription chip. Shows the plan (Starter/Accelerator/
// Pro) when set, otherwise just "Social". Renders nothing for non-social clients.
const PLAN_COLOR = PALETTE.rose; // distinct from the segment palette

export function SocialBadge({
  socialClient,
  socialPlan,
  size = "sm",
}: {
  socialClient?: boolean | null;
  socialPlan?: string | null;
  size?: "sm" | "xs";
}) {
  if (!socialClient && !socialPlan) return null;
  // Only show a plan name when it's a real plan (Starter/Accelerator/Pro), never
  // a truthy placeholder like "yes" that some callers pass for socialPlan.
  const realPlan = socialPlan && !/^(yes|true|y|social)$/i.test(socialPlan.trim()) ? socialPlan.trim() : null;
  const label = realPlan ? `Social · ${realPlan}` : "Social";
  return (
    <Badge color={PLAN_COLOR} className={size === "xs" ? "px-1.5 py-0 text-[10px]" : undefined}>
      {label}
    </Badge>
  );
}
