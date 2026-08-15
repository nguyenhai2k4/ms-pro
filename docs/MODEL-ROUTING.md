# Model Routing Policy

Applies to every dispatch of a subagent, by `tech-lead` or by anyone else. The goal is to
spend reasoning capacity where mistakes are expensive and not where they aren't — without
letting cost optimization quietly degrade the two subsystems this product's credibility
rests on.

## Tiers

| Tier | Model | Use for | Examples in this repo |
|---|---|---|---|
| **H** | `haiku` | Mechanical work, verifiable by inspection, no design judgment | Formatting/lint fixes, file moves, dependency bumps, changelog and doc typo edits, generating fixtures from an already-specified table |
| **S** | `sonnet` | Well-specified implementation with explicit acceptance criteria | CRUD endpoints against a settled schema, React components against a defined interaction spec, migrations for an agreed schema, tests written against explicit `FR-*` criteria, CI workflow config |
| **O** | `opus` | Correctness-critical, algorithmic, distributed, security-sensitive, or cross-cutting | CPM passes and leveling, mutation ordering and conflict resolution, RBAC enforcement model, interface contracts and ADRs, phase decomposition, perf work whose fix is a redesign, any cross-package refactor |

## Routing by requirement group

| Requirement group | Default tier | Floor (cannot route below) |
|---|---|---|
| FR-SCH (dependencies, CPM, float, constraints) | O | **O** |
| FR-RES-05/06 (overallocation, leveling) | O | **O** |
| FR-COL-01..04 (mutation ordering, realtime convergence) | O | **O** |
| FR-ACL (RBAC) | O for design, S for endpoint-by-endpoint application | **S** |
| Migrations / `packages/db` schema changes | S | **S** |
| FR-TSK, FR-CAL, FR-TRK, FR-RPT, FR-IMP (CRUD, reports, import) | S | H only for pure boilerplate |
| FR-VIEW (client views) | S | H only for pure boilerplate |
| Gantt rendering adapter interface | O | **S** |
| Repo scaffolding, CI, Dockerfiles | S | H |
| Interface contracts in `packages/shared-types`, ADRs, phase decomposition | O | **O** |

Floors are **not overridable by task size**. A three-line change to the backward pass is
still tier O.

## Guardrails

**1. Route on blast radius, not diff size.**
The failure mode of complexity-based routing is proxying complexity by lines changed. A
3-line edit to float calculation silently corrupts every schedule in the product; a 500-line
CRUD scaffold does not. Ask what breaks if this is wrong, not how big it is.

**2. De-escalation requires a written acceptance check.**
You may route a task to S or H only if "done" is checkable without judgment. If `tech-lead`
cannot write the acceptance check, the task is not specified well enough to route down —
that's a decomposition problem, and throwing a cheaper model at it converts a planning gap
into a code defect.

**3. Escalation is mandatory, not discretionary.**
Any agent that hits an ambiguous spec, a conflict with an ADR, or a needed interface change
**stops and escalates to `tech-lead`** rather than deciding for itself. Cheap model plus
plausible guess is the actual risk this policy exists to prevent — not cheap model plus
honest "I need a decision."

**4. Two escalations means re-decompose, not re-route.**
If a work item escalates twice, the decomposition is wrong. `tech-lead` re-decomposes it.
Escalating the model a third time is using capability to paper over an unclear task.

**5. Verification never routes below implementation.**
QA on a tier-O module runs at tier O. A cheaper reviewer must not bless more expensive code —
the review is only worth the reasoning behind it, and the CPM/realtime bugs that matter are
exactly the ones a fast skim misses.

**6. Routing decisions are recorded, not implicit.**
Every work item in a phase breakdown carries its tier and a one-line rationale. Routing you
can't review is routing you can't correct.

**7. The floors survive schedule pressure.**
"We're behind, run it at sonnet" is precisely when the floors are load-bearing. Re-scope the
phase instead; see `docs/IMPLEMENTATION-PLAN.md` §8 risk register.

## Applying it

The `model` parameter on a dispatch overrides the agent definition's default, so an agent can
be run below or above its usual tier when the specific task warrants it — subject to the
floors above. Typical legitimate overrides:

- `backend-engineer` at **H** for mechanical boilerplate inside an already-specified module.
- `frontend-engineer` at **O** when the task is the Gantt adapter interface rather than a
  component built on it.
- `qa-engineer` at **O** when writing the CPM property-based suite (tier follows the module
  under test, per guardrail 5).
