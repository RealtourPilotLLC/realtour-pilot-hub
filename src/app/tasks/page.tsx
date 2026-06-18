import { redirect } from "next/navigation";

// The old "Tasks" page dumped Aryeo's raw production/payroll line items (noise).
// Daily Tasks (/queue) is the single, smart task surface now.
export default function TasksPage() {
  redirect("/queue");
}
