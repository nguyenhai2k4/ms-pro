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

## Status

Pre-implementation. This repository contains planning documentation and the team definition;
application code has not been started. P0 (foundations) is the next step.
