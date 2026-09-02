import type { QueueTask, DeliverableStatus, QcClientContext } from "@/components/queue/TaskCard";
import { parseChecklist } from "@/lib/checklist";
import { parseClientProfile } from "@/lib/clientProfile";
import { customerNote as clientCustomerNote } from "@/lib/clientNotes";

// One place that turns a SmartTask row (with its client) into the shape the
// TaskCard renders — used by both the Daily Tasks queue and the project page so
// they never drift. EVERY task type surfaces its checklist JSON as the card's
// tick list (the operational steps live there for all types, not just QC). A QC
// (media_qa) task additionally gets a read-only "know this client" strip built
// from the client's segment / editing prefs / working profile so QC is no
// longer client-blind (38% of deliveries are VIP-segment).
export type TaskRow = {
  id: string;
  title: string;
  taskType: string;
  status: string;
  priority: string;
  dueAt: Date | null;
  createdAt: Date | null;
  reasonCreated: string | null;
  summary: string | null;
  description: string | null;
  checklist: string | null;
  source: string;
  sourceDetail: string | null;
  assignedKey: string | null;
  projectId: string | null;
  clientId: string | null;
  contactName: string | null;
  propertyAddress: string | null;
  // The client join. `name` is always present; the QC-context fields (segment /
  // generalNotes / profileJson) are only selected on the surfaces that show
  // the guided QC card (the task board). Where they're absent the card simply
  // renders no client strip — graceful, so callers that select only `name`
  // (e.g. the project page via getProject) still type-check and work.
  // generalNotes is THE customer note; editingPreferences is the retired column
  // kept as a fallback (see src/lib/clientNotes.ts).
  client: {
    name: string;
    segment?: string | null;
    generalNotes?: string | null;
    editingPreferences?: string | null;
    profileJson?: string | null;
  } | null;
};

// Segments that get the VIP extra-pass treatment on the card. Mirrors
// VIP_SEGMENTS in src/lib/tasks.ts (kept local so this stays free of server-only
// imports — taskView is used by client-facing render paths).
const VIP_SEGMENTS = new Set(["vip", "heavy"]);

// Build the compact, read-only "know this client" context for a QC card from the
// client's profile. All JSON parsing is guarded (parseClientProfile swallows).
// Returns null when there's nothing worth showing.
function qcClientContext(client: TaskRow["client"]): QcClientContext | null {
  if (!client) return null;
  const segment = client.segment ?? null;
  // THE customer note (generalNotes, with the retired editingPreferences as
  // fallback). This read editingPreferences alone — a column with no writer
  // since the notes cards merged, NULL on all 349 clients — so the QC card's
  // client line was dead everywhere while 17 clients had a real note.
  const customerNote = clientCustomerNote(client);
  const profile = parseClientProfile(client.profileJson);
  // The single highest-leverage line: what this client usually asks changed —
  // it predicts the bounce-backs the QC pass is meant to prevent.
  const usuallyAsks = profile?.revisions?.commonTypes?.filter((t) => !!t?.trim()) ?? [];
  const dos = profile?.dos?.filter((t) => !!t?.trim()) ?? [];
  const donts = profile?.donts?.filter((t) => !!t?.trim()) ?? [];
  const isVip = !!segment && VIP_SEGMENTS.has(segment);
  // Nothing to show at all → no strip.
  if (!segment && !customerNote && usuallyAsks.length === 0 && dos.length === 0 && donts.length === 0) {
    return null;
  }
  return { segment, isVip, customerNote, usuallyAsks, dos, donts };
}

export function taskToView(t: TaskRow): QueueTask {
  const isQc = t.taskType === "media_qa";
  const deliverables: DeliverableStatus[] = parseChecklist(t.checklist).map((i) => ({ label: i.label, done: i.done }));
  return {
    id: t.id,
    title: t.title,
    taskType: t.taskType,
    status: t.status,
    priority: t.priority,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    createdAt: t.createdAt ? t.createdAt.toISOString() : null,
    reasonCreated: t.reasonCreated,
    summary: t.summary,
    description: t.description,
    deliverables,
    qcClient: isQc ? qcClientContext(t.client) : null,
    source: t.source,
    sourceDetail: t.sourceDetail,
    assignedKey: t.assignedKey,
    projectId: t.projectId,
    clientId: t.clientId,
    clientName: t.client?.name ?? null,
    contactName: t.contactName,
    propertyAddress: t.propertyAddress,
  };
}
