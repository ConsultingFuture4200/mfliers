# PRD — placeholder / provenance note

> **Status:** The authoritative PRD file (`flier-canvassing-platform-PRD-v0.4.0.md`,
> referenced by `CLAUDE.md` and every task card) was **not delivered** with the spec
> bundle. This file stands in as a provenance marker.

## What to build from instead

The build is fully executable without the standalone PRD because the requirements it
would contain are **quoted inline** in the governing documents that *are* present:

- **Constitution** — `docs/constitution.md` (stack, code standards, security, anti-patterns).
- **Phase-1 plan** — `docs/phase-1-plan.html` (deliverables, exit criteria EC-1…EC-7, batch sequence).
- **Task cards** — `docs/tasks/batch-1.md` … `batch-5.md`. Each card quotes the exact
  `FR-*` requirements and `EC-*` exit criteria it implements, plus the constitution
  sections it must honor.

## Rule

If any card cites a PRD section whose content is **not** quoted inline in that card,
do **not** guess: insert a `NEEDS_CLARIFICATION:` note in the code/PR and surface it.
See `tasks/lessons.md`.
