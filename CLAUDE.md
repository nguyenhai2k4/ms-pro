# ProjectApp — Working Agreement

Web-native project scheduling tool (Gantt/CPM core + real-time collaboration).
Planning docs are the contract; read them before writing code.

| Doc | Use it for |
|---|---|
| `docs/PRD.md` | Product scope and vision (source of truth for *what*) |
| `docs/FRS.md` | Numbered functional requirements (`FR-*`), use cases, data model |
| `docs/IMPLEMENTATION-PLAN.md` | Architecture, ADR-001..005, roadmap phases P0-P8, risk register |
| `docs/TEAM.md` | Who owns what — agent roster and ownership matrix |
| `docs/MODEL-ROUTING.md` | Which model tier a task runs at, and the floors that can't be overridden |

**Every PR/commit must cite the `FR-*` IDs it implements.** If work doesn't map to an
`FR-*` ID, it is either out of scope or the FRS needs updating first — say so rather than
silently building it.

## Repository layout (target)

```
apps/
  web/          React 18 + TS SPA (Gantt, Grid, Kanban, Calendar, reports)
  api/          Fastify REST API, authn/authz, CRUD, exports
  scheduler/    Scheduler service: mutation queue + realtime hub (stateful, per-project)
packages/
  cpm-engine/   Pure CPM/leveling algorithms — no I/O, no DB, no network
  shared-types/ TS types + zod schemas shared across api/web/scheduler
  db/           Postgres schema, migrations, query layer
infra/          Dockerfiles, compose, CI, deploy manifests
docs/           PRD, FRS, implementation plan, team, ADRs
```

**Status: nothing is scaffolded yet.** P0 (`docs/IMPLEMENTATION-PLAN.md` §6) creates this
structure. Do not assume a build command exists — check `package.json` before running one.

## Stack (locked by ADRs — do not substitute without a new ADR)

- **Language:** TypeScript everywhere, Node 20 LTS (ADR-003 — not Go for MVP)
- **Backend:** Fastify · PostgreSQL 15+ · Redis (pub/sub + BullMQ) · S3-compatible storage
- **Frontend:** React 18 · Zustand (client state) · TanStack Query (server cache) · TanStack Table (grid)
- **Gantt:** licensed component (Bryntum/DHTMLX) behind an internal adapter interface (ADR-001)
- **Realtime:** server-authoritative ordered mutations for schedule data; Yjs **only** for free text (ADR-002)
- **Monorepo:** pnpm workspaces

## Non-negotiable invariants

1. **The CPM engine is pure.** `packages/cpm-engine` takes a graph in, returns a schedule
   out. No DB calls, no clock reads, no randomness. Same input → byte-identical output.
2. **Schedule mutations are server-authoritative and ordered per project.** Clients send
   intents, never authoritative state. Never merge two concurrent date edits via CRDT (ADR-002).
3. **RBAC is enforced server-side on every mutating endpoint** (FR-ACL-04). Hiding a button
   is not access control.
4. **Every schedule-affecting mutation writes an audit log entry** with before/after (FR-COL-07).
5. **Perf budgets are tested, not assumed** (FR-SCH-06): full recalc <500ms @ 5k tasks,
   incremental <150ms, Gantt paint <1s @ 2k visible rows.
6. **Accessibility is built in, not retrofitted.** The canvas Gantt ships with a synchronized
   accessible table representation from the start — this is in the risk register for a reason.
7. **Escalate rather than guess.** An ambiguous spec, an ADR conflict, or a needed interface
   change stops the work and goes to `tech-lead`. Guessing is the failure mode that model
   routing exists to prevent (`docs/MODEL-ROUTING.md` guardrail 3).

## Conventions

- Branch: `claude/<short-topic>`. Commit subject: imperative, ≤72 chars, then a body citing `FR-*` IDs.
- Tests live next to source (`*.test.ts`). Vitest for unit, Playwright for e2e.
- No `any` in committed TS. No `--force` pushes to shared branches.
- Migrations are forward-only and reviewed by the backend owner.
- Secrets never enter the repo — env vars only, documented in `.env.example`.

## Definition of done

Types pass · lint passes · tests pass (incl. new tests for the `FR-*` implemented) ·
perf budget unaffected or re-measured · docs updated if an interface or ADR changed.
