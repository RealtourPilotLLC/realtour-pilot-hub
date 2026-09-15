"use client";

import { useState, useTransition } from "react";
import { Loader2, MessageSquare, Search } from "lucide-react";
import { saveSlackId, findSlackIdOnSlack } from "@/app/team/actions";
import { SLACK_MEMBER_ID_RE } from "@/lib/slackScopes";

// The one field that makes an @mention or a reply reach a person on Slack
// (Jordan, Sep 15). Owner/admin edit it on the People card; the green chip
// says the bridge is live for that person. "Find on Slack" asks Slack by the
// email on the Team row — the bot token installed today lacks
// users:read.email, so until the app is re-installed the button answers with
// the exact fix instead of an ID (that text comes from the server action).
export function SlackIdField({
  memberId,
  firstName,
  slackId,
  canEdit,
}: {
  memberId: string;
  firstName: string;
  slackId: string | null;
  canEdit: boolean;
}) {
  const [current, setCurrent] = useState(slackId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(slackId ?? "");
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [pending, start] = useTransition();
  const trimmed = value.trim().toUpperCase();
  const valid = trimmed === "" || SLACK_MEMBER_ID_RE.test(trimmed);

  const save = () =>
    start(async () => {
      const r = await saveSlackId(memberId, trimmed || null);
      setNote({ ok: r.ok, msg: r.message });
      if (r.ok) {
        setCurrent(trimmed || null);
        setEditing(false);
      }
    });
  const find = () =>
    start(async () => {
      const r = await findSlackIdOnSlack(memberId);
      setNote({ ok: r.ok, msg: r.message });
      if (r.ok && r.slackId) {
        setCurrent(r.slackId);
        setValue(r.slackId);
        setEditing(false);
      }
    });

  const btn =
    "inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-60";

  return (
    <div className="mt-3 border-t border-border pt-3 text-xs" data-slack-id-field>
      <div className="flex flex-wrap items-center gap-2">
        {current ? (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success"
            title="Mentions and replies DM this person on Slack"
          >
            <MessageSquare className="size-3" /> Slack ✓ <span className="font-mono">{current}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
            <MessageSquare className="size-3" /> No Slack ID — mentions ring the bell only
          </span>
        )}
        {canEdit && !editing && (
          <>
            <button type="button" onClick={() => { setEditing(true); setNote(null); }} className={btn}>
              {current ? "Edit" : "Add Slack ID"}
            </button>
            <button type="button" onClick={find} disabled={pending} className={btn} title={`Look ${firstName} up on Slack by email`}>
              {pending ? <Loader2 className="size-3 animate-spin" /> : <Search className="size-3" />} Find on Slack
            </button>
          </>
        )}
      </div>
      {canEdit && editing && (
        <div className="mt-2 space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-muted">Slack member ID</label>
          <div className="flex gap-2">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="U07SCBTPDC7"
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-sm outline-none focus:border-brand"
            />
            <button
              type="button"
              onClick={save}
              disabled={pending || !valid}
              className="inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
            >
              {pending ? <Loader2 className="size-3 animate-spin" /> : null} Save
            </button>
            <button type="button" onClick={() => { setEditing(false); setValue(current ?? ""); setNote(null); }} className={btn}>
              Cancel
            </button>
          </div>
          {!valid && <p className="text-danger">A member ID starts with U or W and is 9–13 characters (letters and digits).</p>}
          <p className="text-muted-2">In Slack: click the person → ⋯ → Copy member ID</p>
        </div>
      )}
      {note && <p className={`mt-1.5 ${note.ok ? "text-success" : "text-warning"}`}>{note.msg}</p>}
    </div>
  );
}
