# ProjectApp

Web-native project scheduling and collaboration tool (Gantt/CPM core, real-time
multi-user editing) — a lower-cost, browser-first alternative to MS Project for
mid-market teams.

## Docs

- [`docs/PRD.md`](docs/PRD.md) — Product Requirements Document (source of truth for scope/vision).
- [`docs/FRS.md`](docs/FRS.md) — Functional Requirements Specification: complexity assessment,
  numbered functional requirements, use cases, and persona user journeys.
- [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) — Architecture, technology stack
  decisions (with the PRD's open questions resolved as ADRs), effort/time budget, staffing
  scenarios, and the phased roadmap.
- [`docs/TEAM.md`](docs/TEAM.md) — Development team: agent roster, ownership matrix, phase
  assignments.
- [`docs/MODEL-ROUTING.md`](docs/MODEL-ROUTING.md) — Model tier per task, and the floors that
  can't be overridden.
- [`CLAUDE.md`](CLAUDE.md) — Working agreement: repo layout, locked stack, invariants, conventions.

## Development team

The team is defined as Claude Code subagents in [`.claude/agents/`](.claude/agents) — one
specialist per ownership boundary (`tech-lead`, `scheduler-engineer`, `realtime-engineer`,
`backend-engineer`, `frontend-engineer`, `qa-engineer`, `devops-engineer`).

`tech-lead` orchestrates: it decomposes a phase into waves, routes each work item to the
owning agent at a model tier chosen per [`docs/MODEL-ROUTING.md`](docs/MODEL-ROUTING.md),
dispatches, verifies acceptance, then hands to `qa-engineer`. Hand it a phase:

```
Use the tech-lead agent to decompose and execute P0.
```

See [`docs/TEAM.md`](docs/TEAM.md) for who owns which requirements and phases.

## Getting started

Requires Node 20+ (ADR-003 targets Node 20 LTS; CI pins it) and pnpm 10.

```bash
pnpm install
cp .env.example .env                              # fill in local values
docker compose -f infra/docker-compose.yml up -d  # Postgres, Redis, MinIO
pnpm --filter @projectapp/db migrate              # forward-only migrations
pnpm --filter @projectapp/api dev                 # API on :3001
pnpm --filter @projectapp/web dev                 # SPA on :5173
```

Verification, the same commands CI runs:

```bash
pnpm -r typecheck && pnpm -r lint && pnpm format && pnpm -r test
```

## Status

**P0 (Foundations) — largely landed; two items outstanding.** See
[`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) §6.

Landed: pnpm workspace and toolchain, CI, local dev stack, the interface contracts in
`packages/shared-types`, the database schema and migration runner, the API (auth, org/project
shell, RBAC, audit log), and the web shell with the Gantt adapter contract and its accessible
table representation.

Outstanding and tracked, not silently dropped:

- **Gantt vendor integration** ([`docs/adr/ADR-006`](docs/adr/ADR-006-gantt-adapter-contract-and-placeholder.md)) —
  no license and no vendor registry access, so a development-only placeholder sits behind the
  adapter contract. **FR-VIEW-01 and FR-VIEW-02 are not satisfied.** Gated before P1 exit.
- **FR-AUTH-02** (Google/Microsoft OAuth) — the managed provider is not configured; password
  auth only.
- **Email delivery** — password-reset tokens are minted and consumed correctly but not sent.

P1 (Task/WBS core) is next.
