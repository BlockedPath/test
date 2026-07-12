# PROTOTYPE — First-use coding workspace flow

**Throwaway.** Answers issue #5. Not production code.

## Question

What should the first-use and primary coding workspace flow look like for a user who dislikes a TUI?

Explore: project-open, conversation, file tree, lightweight editor/diff, activity panel, approval prompts, YOLO toggle, cancellation, and recovery after error.

## Plan

Three structurally different variants on one page, switchable via `?variant=` and a floating bottom bar:

| Key | Name | Structure |
|-----|------|-----------|
| `A` | Workbench | Classic IDE: file tree left, editor/diff center, chat right, activity bottom |
| `B` | Conversation-first | Chat is the main surface; files/diff/activity as secondary rails and inline cards |
| `C` | Mission Control | Split cockpit: session controls + chat left; Files/Diff/Terminal tabs right; wizard open |

## Run

```bash
# from repo root
python3 -m http.server 5173 --directory prototypes/first-use-workspace
```

Open: http://localhost:5173/?variant=A

Keys: `←` / `→` cycle variants (when not typing).

## Demo script (same in every variant)

1. **Open project** from empty state (pick the demo folder).
2. Type a prompt (or use **Run demo turn**).
3. Hit an **approval** (edit or command) — Approve / Deny.
4. Inspect **diff** and **activity**.
5. Toggle **YOLO** (warning + visible state).
6. **Cancel** a running turn.
7. Trigger **error / recovery** and try Retry / Reset / CLI fallback.

State is in-memory only. Reload resets.

## Verdict (2026-07-12)

**Chosen: B — Conversation-first**, plus:

- **C** only for first open (project → trust summary → enter)
- **A** only for expandable files/full diff when reviewing

Approvals inline; YOLO warned + pill; Stop by Send; recovery in chat column.

See issue #5 verdict comment. Prototype stays throwaway.

## Out of scope

Real agent engine, real filesystem, real auth, packaging, multi-project windows.
