"use client";

import { useRef, useState } from "react";
import { MessageSquare, Search } from "lucide-react";
import { Button, ActionLink } from "@/components/ui/Action";
import { TextField } from "@/components/ui/FormField";
import { saveSlackId, findSlackIdOnSlack } from "@/app/team/actions";
import { SLACK_MEMBER_ID_RE } from "@/lib/slackScopes";
import { useSlackAttempt } from "./useSlackAttempt";

// The server re-checks owner/admin access, the exact Team row and uniqueness.
// A found ID is saved by that action; it is not merely a local suggestion.
export function SlackIdField({ memberId, firstName, slackId, canEdit }: {
  memberId: string; firstName: string; slackId: string | null; canEdit: boolean;
}) {
  const [saved, setSaved] = useState<{ memberId: string; base: string | null; value: string | null } | null>(null);
  const current = saved?.memberId === memberId && saved.base === slackId ? saved.value : slackId;
  const [editing, setEditing] = useState(false), [value, setValue] = useState(slackId ?? "");
  const draft = useRef({ value: slackId ?? "", revision: 0 });
  const [note, setNote] = useState<{ memberId: string; ok: boolean; msg: string } | null>(null);
  const attempt = useSlackAttempt(`slack-id-unconfirmed:${memberId}`);
  const trimmed = value.trim().toUpperCase(), valid = trimmed === "" || SLACK_MEMBER_ID_RE.test(trimmed);

  async function run(kind: "save" | "find") {
    if (!canEdit) return;
    const requested = draft.current.value.trim().toUpperCase();
    if (kind === "save" && requested && !SLACK_MEMBER_ID_RE.test(requested)) return;
    const revision = draft.current.revision;
    const id = attempt.begin(kind);
    if (!id) return;
    setNote(null);
    try {
      const r = kind === "save" ? await saveSlackId(memberId, requested || null) : await findSlackIdOnSlack(memberId);
      const confirmed = r.ok && r.outcome === "confirmed";
      const known = confirmed || (!r.ok && r.outcome === "refused");
      const actual = kind === "save" ? requested || null : "slackId" in r && typeof r.slackId === "string" ? r.slackId : null;
      const unchanged = draft.current.revision === revision;
      if (confirmed) {
        setSaved({ memberId, base: slackId, value: actual });
        if (unchanged) {
          draft.current.value = actual ?? ""; setValue(actual ?? ""); setEditing(false);
        }
      }
      setNote({ memberId, ok: confirmed, msg: r.message + (confirmed ? ` Confirmed ID: ${actual ?? "cleared"}.` : "") + (confirmed && !unchanged ? " Your newer local input has been kept; this response is for the earlier request." : "") });
      attempt.finish(id, known);
    } catch { attempt.finish(id, false); }
  }
  function edit() {
    draft.current = { value: current ?? "", revision: draft.current.revision + 1 };
    setValue(current ?? ""); setEditing(true); setNote(null);
  }
  const visibleNote = note?.memberId === memberId ? note : null;
  return (
    <div className="mt-3 border-t border-border pt-3 text-sm" data-slack-id-field>
      <div className="flex flex-wrap items-center gap-2">
        {current ? (
          <span className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full bg-success-soft px-2 py-1 text-sm font-medium text-success"
            title="Mentions and replies DM this person on Slack">
            <MessageSquare className="size-4" /> Slack ✓ <span className="break-all font-mono">{current}</span>
          </span>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1 rounded-full bg-surface-2 px-2 py-1 text-sm font-medium text-muted">
            <MessageSquare className="size-4" /> No Slack ID — mentions ring the bell only
          </span>
        )}
        {canEdit && !editing && <>
          <Button variant="secondary" onClick={edit}>{current ? "Edit" : "Add Slack ID"}</Button>
          <Button variant="secondary" onClick={() => run("find")} disabled={attempt.blocked} busy={attempt.pending} title={`Look ${firstName} up on Slack by email`}>
            <Search className="size-4" /> Find on Slack
          </Button>
        </>}
      </div>
      {canEdit && editing && <div className="mt-3 space-y-2">
        <TextField id={`slack-member-id-${memberId}`} name="slackId" label={`Slack member ID for ${firstName}`} value={value}
          onChange={(e) => { draft.current = { value: e.target.value, revision: draft.current.revision + 1 }; setValue(e.target.value); }}
          placeholder="U07SCBTPDC7" spellCheck={false} autoComplete="off" inputClassName="font-mono"
          error={valid ? null : "A member ID starts with U or W and is 9–13 characters (letters and digits)."}
          hint="In Slack: click the person → ⋯ → Copy member ID" />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => run("save")} disabled={attempt.blocked || !valid} busy={attempt.pending}>Save</Button>
          <Button variant="secondary" disabled={attempt.blocked} onClick={() => { draft.current = { value: current ?? "", revision: draft.current.revision + 1 }; setEditing(false); setValue(current ?? ""); setNote(null); }}>Cancel</Button>
        </div>
      </div>}
      {attempt.held && <div role="alert" className="mt-3 space-y-2 rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm leading-relaxed">
        <p>The Slack ID change for {firstName} is unconfirmed. It may already have been saved. Ask Kyle to inspect this Team row and request logs before saving or finding the ID again.</p>
        <p>This tab holds repeats. Reloading does not prove the earlier write ended. Local input is kept only while this editor stays open.</p>
        <ActionLink href={`/team/${memberId}`}>Inspect {firstName}’s Team row</ActionLink>
      </div>}
      {attempt.localError && <p role="alert" className="mt-2 text-danger">{attempt.localError}</p>}
      {visibleNote && <p role={visibleNote.ok ? "status" : "alert"} className={`mt-2 leading-relaxed ${visibleNote.ok ? "text-success" : "text-warning"}`}>{visibleNote.msg}</p>}
    </div>
  );
}
