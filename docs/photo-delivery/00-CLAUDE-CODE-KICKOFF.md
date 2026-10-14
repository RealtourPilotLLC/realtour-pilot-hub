# Kickoff prompt for Claude Code

Copy the five files in this folder into the Ops Hub repo under `docs/photo-delivery/` (put `qc-rules.seed.json` there too for now), then paste this into Claude Code:

---

We're building the Photo Delivery automation for the Realtour Pilot Ops Hub. The full spec is in `docs/photo-delivery/`:

- `01-PHOTO-DELIVERY-PLAN.md` is the main plan. Follow it.
- `02-QC-RULES-REGISTRY.md` and `qc-rules.seed.json` are the QC rules (one rule per checklist bullet).
- `03-QC-CHECKLIST.md` is our QC standard.
- `04-QC-PROMPT-PACK.md` has every Claude prompt and JSON schema.

Start with section 0 of the plan. Read CLAUDE.md and the repo, confirm the Phase 0 stabilization items are fixed, and write `docs/photo-delivery/GAP_ANALYSIS.md` with the exact file map you'll create, adapted to our conventions. Don't write feature code yet. Show me the gap analysis and your Phase 0 and Phase 1 task list first, plus anything in the plan marked [VERIFY] that you can check with a live call once credentials are in place.

Rules: never use em dashes in any user-facing copy; never hardcode AutoHDR prices or model ids; never blindly retry anything that spends AutoHDR credits; verify every webhook signature.
