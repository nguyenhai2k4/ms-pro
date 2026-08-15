# Development Team

The team is defined as Claude Code subagents in `.claude/agents/`. Each agent is a
specialist with an explicit ownership boundary, the `FR-*` requirements it's accountable for,
and the constraints it must not violate. Shared conventions live in `CLAUDE.md`.

Composition mirrors **Scenario B** from `docs/IMPLEMENTATION-PLAN.md` §5 (the recommended
staffing: 4 engineers + QA + part-time lead/DevOps), which the plan estimates at ~5-5.5
months of engineering to MVP plus a beta tail.

## Roster

| Agent | Owns | Model | Why it's separate |
|---|---|---|---|
| `tech-lead` | `docs/`, interface contracts, ADRs, phase decomposition | opus | Someone has to own coherence across packages and stop P2-scope creep |
| `scheduler-engineer` | `packages/cpm-engine`, scheduler compute path | opus | Highest-risk module; correctness-critical and algorithmically specialized |
| `realtime-engineer` | Mutation queue, WebSocket hub, presence, Yjs | opus | Second-highest risk; distributed-systems reasoning, distinct from CRUD work |
| `backend-engineer` | `apps/api`, `packages/db` | sonnet | High-volume, well-understood CRUD/RBAC/reporting surface |
| `frontend-engineer` | `apps/web` | sonnet | Gantt/Grid interaction quality is a product differentiator in its own right |
| `qa-engineer` | Tests across all packages | sonnet | The two risky subsystems fail silently; independent verification is the control |
| `devops-engineer` | `infra/`, CI/CD, observability | sonnet | Scheduler affinity + perf instrumentation are real design work, not just scripts |

Opus is assigned where the reasoning is hardest and mistakes are most expensive (scheduling
correctness, distributed ordering, architecture). Sonnet handles the broader,
better-specified surfaces.

## Ownership matrix

| Requirement group | Primary | Supporting |
|---|---|---|
| FR-TSK (tasks, WBS) | `backend-engineer` | `frontend-engineer`, `scheduler-engineer` (rollup math) |
| FR-SCH (dependencies, CPM) | `scheduler-engineer` | `qa-engineer` |
| FR-RES (resources, leveling) | `scheduler-engineer` (05-06), `backend-engineer` (01-04, 07) | — |
| FR-CAL (calendars) | `backend-engineer` (persistence) | `scheduler-engineer` (date math) |
| FR-VIEW (Gantt, grid, views) | `frontend-engineer` | — |
| FR-TRK (baselines, tracking) | `backend-engineer` | `frontend-engineer` |
| FR-COL-01..04 (realtime) | `realtime-engineer` | `frontend-engineer` |
| FR-COL-05..08 (comments, audit) | `backend-engineer` | — |
| FR-ACL (RBAC) | `backend-engineer` | `realtime-engineer` (socket enforcement), `qa-engineer` |
| FR-RPT (reports, export) | `backend-engineer` | `frontend-engineer` |
| FR-IMP (import) | `backend-engineer` | `frontend-engineer` (mapping UI) |
| Perf budgets | `qa-engineer` (enforcement) | owner of the affected module |
| Accessibility | `frontend-engineer` | `qa-engineer` |

## Phase assignments

From the roadmap in `docs/IMPLEMENTATION-PLAN.md` §6:

| Phase | Lead agent | Also active |
|---|---|---|
| P0 Foundations | `devops-engineer` | `tech-lead`, `frontend-engineer` (Gantt spike), `backend-engineer` (schema) |
| P1 Task/WBS core | `backend-engineer` | `frontend-engineer`, `qa-engineer` |
| P2 Scheduling engine | `scheduler-engineer` | `qa-engineer` (golden files), `frontend-engineer` (critical path render) |
| P3 Real-time collab | `realtime-engineer` | `frontend-engineer`, `qa-engineer` |
| P4 Resources & cost | `scheduler-engineer` + `backend-engineer` | `frontend-engineer` |
| P5 Tracking & views | `backend-engineer` | `frontend-engineer` |
| P6 Collab surface & RBAC | `backend-engineer` | `qa-engineer` (negative paths) |
| P7 Reporting & export | `backend-engineer` | `frontend-engineer` |
| P8 Hardening | `qa-engineer` + `devops-engineer` | all |

## How to use the team

```
Use the tech-lead agent to decompose P0 into work items.
Use the scheduler-engineer agent to implement the forward/backward pass (FR-SCH-04, FR-SCH-05).
Use the qa-engineer agent to review whether P2 meets its acceptance criteria.
```

Guidance for running them:

- **Start each phase with `tech-lead`** to land interface contracts in
  `packages/shared-types` first. Parallel agents collide at exactly those seams, so defining
  them upfront is what makes parallelism safe.
- **Parallelize within a phase, serialize across the risky ones.** P2 and P3 are deliberately
  sequential — realtime is built against a stable engine, not a moving one.
- **`qa-engineer` reviews, it doesn't rubber-stamp.** A phase with green tests and uncovered
  `FR-*` IDs is not done.
- Give each agent the `FR-*` IDs it's implementing. That's the shared vocabulary between the
  FRS, the commits, and the tests.

## What this team does not cover

Product/UX design, pricing and go-to-market, the SOC 2 readiness process (long lead time —
start it in parallel with MVP if enterprise sales is near-term), and pilot-customer management
during beta. Those are human roles, not engineering agents, and the plan budgets ~10-12
person-weeks of design/PM time that lives outside this roster.
