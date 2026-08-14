# Functional Requirements Specification: ProjectApp
**Version:** 1.0 | **Status:** Draft for review | **Derived from:** PRD v0.1 (`docs/PRD.md`)
**Author:** Claude (analysis) | **Date:** 2026-08-14

This FRS translates the PRD into testable, numbered requirements, concrete use cases, and
persona-level user journeys. Companion document `docs/IMPLEMENTATION-PLAN.md` covers
architecture, tech stack decisions, effort/time budget, and the phased roadmap.

---

## 1. Complexity Assessment

Before specifying requirements, it's worth being explicit about where the real engineering
risk sits, because it drives sequencing and staffing in the implementation plan.

| Module | Complexity | Why |
|---|---|---|
| Task CRUD / WBS rollup | Low–Medium | Standard tree CRUD; rollup math (dates/duration/% complete) is well-defined but has edge cases (mixed-mode children, manual vs auto tasks in the same subtree). |
| Dependency graph + CPM engine | **High** | Correctness-critical (forward/backward pass, four dependency types with lag/lead, constraint types, calendars-per-task). Must handle cycles, partial graphs, and incremental recompute for perf. This is the product's core differentiator — under-investing here undermines the whole pitch. |
| Resource leveling | **High** | NP-hard in the general case (a scheduling/bin-packing problem); PRD scopes "basic, priority-based" leveling which is tractable, but even the simplified version interacts with calendars, units%, and the CPM engine and is easy to get subtly wrong. |
| Gantt rendering | Medium–High (or Low if bought) | DOM-based grids fall over past ~1,000 rows; canvas/WebGL rendering with virtualization, drag-resize, dependency-line drawing, and critical-path highlighting is a substantial UI engineering project in isolation. Buy-vs-build is the single biggest lever on timeline (see §7 of the implementation plan). |
| Real-time collaboration | **High** | Naive CRDT-everywhere doesn't fit a derived-state domain (CPM recalculation must stay server-authoritative and deterministic). Needs a hybrid design — see ADR-002 in the implementation plan. |
| RBAC / auth | Medium | Standard, but 4 roles × project-scoped membership × audit log adds real surface area to test. |
| Reporting/export | Medium | Burndown/burnup and utilization reports are aggregation queries; PDF/PNG/XLSX export of a canvas Gantt needs a server-side rendering path, not just "print the DOM." |
| Baselines/tracking | Low–Medium | Snapshot + diff; mechanically simple once the task model is stable. |

**Bottom line:** two subsystems — the CPM engine and real-time collaboration — carry
disproportionate risk and should be built and hardened before anything else is layered on
top (see roadmap ordering in the implementation plan, which resequences the PRD's milestone
order slightly for this reason).

---

## 2. Actors

| Actor | Definition |
|---|---|
| **Admin** | Full control over a project: membership, roles, deletion, settings, calendars. |
| **Editor** | Full scheduling control: create/edit/delete tasks, dependencies, resources, baselines. Cannot manage membership/roles or delete the project. |
| **Contributor** | Can update tasks assigned to them (% complete, actual dates, notes, comments) but cannot restructure the schedule (no create/delete tasks, no dependency edits). |
| **Viewer** | Read-only access to all views and reports. Can comment (configurable) but not edit. |
| **System (scheduler service)** | Non-human actor that recalculates CPM/rollups on any mutating event. |

Role permissions are enforced server-side on every mutating endpoint, not just hidden in the UI.

---

## 3. Functional Requirements

Requirements use **shall** language and stable IDs (`FR-<module>-<n>`) so they can be traced
to test cases and PRs. "MVP" = must ship in Phase 1; "P2" = Phase 2 per PRD scope.

### 3.1 Task & WBS Management (FR-TSK)

| ID | Requirement | Priority |
|---|---|---|
| FR-TSK-01 | The system shall allow creating, editing, and deleting tasks with: name, duration, start, finish, % complete, notes, priority, WBS code. | MVP |
| FR-TSK-02 | The system shall support arbitrary-depth parent/child task hierarchy (WBS). | MVP |
| FR-TSK-03 | Parent task dates, duration, and % complete shall auto-roll up from children (min(start), max(finish), duration derived from span, % complete duration-weighted by default). | MVP |
| FR-TSK-04 | The system shall support "milestone" tasks (duration = 0, distinct icon, cannot have work assigned). | MVP |
| FR-TSK-05 | The system shall support per-task scheduling mode: **Auto** (engine sets dates) or **Manual** (user-fixed dates, excluded from auto-shift but still contributes to parent rollup and can still appear on/off critical path). | MVP |
| FR-TSK-06 | The system shall support constraint types: ASAP, ALAP, Must Start On (MSO), Must Finish On (MFO), Start No Earlier Than (SNET), Start No Later Than (SNLT), Finish No Earlier Than (FNET), Finish No Later Than (FNLT). | MVP |
| FR-TSK-07 | The system shall support a per-task calendar override (working days/hours) distinct from the project default calendar. | MVP |
| FR-TSK-08 | Deleting a task with children shall require explicit confirmation and cascade-delete or re-parent children (user choice). | MVP |
| FR-TSK-09 | Deleting a task that is a predecessor/successor in a dependency shall remove the dependency and trigger recalculation. | MVP |
| FR-TSK-10 | The system shall support recurring tasks (template + generated instances). | P2 |
| FR-TSK-11 | The system shall support custom fields (text/number/date/dropdown) and formula fields on tasks. | P2 |

### 3.2 Dependencies & Scheduling Engine (FR-SCH)

| ID | Requirement | Priority |
|---|---|---|
| FR-SCH-01 | The system shall support dependency types FS, SS, FF, SF between any two tasks in the same project. | MVP |
| FR-SCH-02 | Dependencies shall support signed lag/lead in days (or hours, calendar-aware). | MVP |
| FR-SCH-03 | The system shall reject dependency edits that would introduce a cycle, with a clear error identifying the cycle. | MVP |
| FR-SCH-04 | On any mutation affecting the schedule (task duration/dates, dependency add/remove/change, calendar change, constraint change), the system shall recompute Early Start/Finish (forward pass) and Late Start/Finish (backward pass) for all tasks in the affected connected subgraph. | MVP |
| FR-SCH-05 | The system shall compute Total Float = LS − ES per task and mark tasks with Float = 0 as **critical path**. | MVP |
| FR-SCH-06 | Full-project recalculation shall complete in **&lt;500ms for 5,000 tasks** (p95); incremental (subgraph) recalculation shall complete in **&lt;150ms** for typical single-task edits regardless of project size, achieved via topological-sort-from-changed-node rather than full recompute. | MVP |
| FR-SCH-07 | Recalculation shall respect project/task/resource calendars (skip non-working days/hours) when converting duration to dates. | MVP |
| FR-SCH-08 | Auto-scheduled tasks whose predecessors move shall shift automatically; manually-scheduled tasks shall not move but shall visually flag a resulting date conflict (predecessor finishes after a manual task's fixed start, for FS). | MVP |
| FR-SCH-09 | The system shall support project-level forward scheduling (from a fixed start date) as MVP; backward scheduling from a fixed deadline is P2. | MVP / P2 |
| FR-SCH-10 | The critical path shall be visually distinguished (red) in the Gantt view and filterable in the grid view. | MVP |

### 3.3 Resource Management (FR-RES)

| ID | Requirement | Priority |
|---|---|---|
| FR-RES-01 | The system shall support three resource types: Work (people), Material, Cost. | MVP |
| FR-RES-02 | Work resources shall have: name, rate (per hour or per use), max units (e.g., 100% = 1 FTE, 200% = 2 people in the same pool), calendar. | MVP |
| FR-RES-03 | The system shall support assigning one or more resources to a task, each with an independent units % (e.g., Alice 50%, Bob 100%). | MVP |
| FR-RES-04 | Assignment work hours shall be computed as `duration × units% × task-calendar working hours`, and shall recompute duration if work hours are edited directly (effort-driven scheduling), configurable per task. | MVP |
| FR-RES-05 | The system shall detect resource overallocation (assigned work exceeding available capacity from the resource calendar in any given period) and flag it visually in the Resource Sheet and via a badge on affected tasks. | MVP |
| FR-RES-06 | The system shall provide a "level now" action that delays lower-priority tasks (task `priority` field, then late-start-first tie-break) within their available float to resolve overallocation, without extending the project finish date where possible; if leveling cannot resolve within float, the system shall report which tasks could not be leveled and by how much they'd need to slip. | MVP |
| FR-RES-07 | The system shall compute task/project cost as `Σ(work hours × resource rate) + Σ(material qty × material rate) + fixed costs`. | MVP |
| FR-RES-08 | Cross-project resource pooling (an org-wide resource pool shared/leveled across multiple projects) is out of scope for MVP. | P2 (non-goal per PRD §1) |

### 3.4 Calendars (FR-CAL)

| ID | Requirement | Priority |
|---|---|---|
| FR-CAL-01 | Each project shall have a default calendar (working days of week, working hours per day). | MVP |
| FR-CAL-02 | Calendars shall support date-specific exceptions (holidays, half-days) that override the weekly pattern. | MVP |
| FR-CAL-03 | Resources and tasks may reference a non-default calendar (e.g., an individual's PTO calendar). | MVP |
| FR-CAL-04 | The system shall ship a small set of regional calendar templates (e.g., US, and a generic Mon–Fri) selectable at project creation. | MVP |

### 3.5 Views (FR-VIEW)

| ID | Requirement | Priority |
|---|---|---|
| FR-VIEW-01 | Gantt: shall render bars proportional to duration on a zoomable time axis (day/week/month/quarter), support drag-to-move and drag-to-resize with live date preview, and draw dependency arrows between related bars. | MVP |
| FR-VIEW-02 | Gantt shall highlight the critical path in red and shall remain performant (<1s initial paint, <16ms interaction frame budget) for 2,000 simultaneously visible tasks via row virtualization. | MVP |
| FR-VIEW-03 | Task Grid: spreadsheet-style, shall support inline cell editing, column sort, column filter, column show/hide/reorder, and shall stay in sync with the Gantt (same underlying selection/scroll where applicable). | MVP |
| FR-VIEW-04 | Resource Sheet: list of resources with allocation % over time and overallocation flags. | MVP |
| FR-VIEW-05 | Calendar view: month/week grid showing tasks by date, read/light-edit. | MVP |
| FR-VIEW-06 | Kanban board: status-based columns, per-project toggle to enable; drag between columns updates a `status` field (does not affect scheduling dates unless explicitly mapped). | MVP |
| FR-VIEW-07 | All views shall reflect real-time edits from other collaborators without a manual refresh (see FR-COL). | MVP |

### 3.6 Tracking & Baselines (FR-TRK)

| ID | Requirement | Priority |
|---|---|---|
| FR-TRK-01 | The system shall allow saving a named baseline (point-in-time snapshot of task dates, duration, cost, work) at any time; multiple baselines per project shall be retained (at minimum Baseline 0 + 2 interim). | MVP |
| FR-TRK-02 | The system shall display baseline vs. current variance (start/finish date delta in days, cost delta) per task and rolled up per project. | MVP |
| FR-TRK-03 | The system shall support a project "status date" and capture actual start/actual finish independent of scheduled start/finish. | MVP |
| FR-TRK-04 | % complete rollup to parent tasks shall be duration-weighted by default with an option for manual override at the parent level. | MVP |

### 3.7 Collaboration (FR-COL)

| ID | Requirement | Priority |
|---|---|---|
| FR-COL-01 | Multiple users editing the same project concurrently shall see each other's changes propagate within ~200ms (same-region) without manual refresh and without silent data loss. | MVP |
| FR-COL-02 | Structural schedule mutations (task edits, dependency changes, resource assignment) shall be applied through a single server-authoritative ordering per project so CPM recalculation stays deterministic; concurrent conflicting edits to the same field shall resolve last-write-wins with the loser notified, not silently dropped. | MVP |
| FR-COL-03 | Free-text collaborative fields (task notes, comment bodies) may use CRDT merge (Yjs) for character-level concurrent typing. | MVP |
| FR-COL-04 | Users shall see live cursors/presence indicators (who's viewing/editing which task) in Gantt and Grid views. | MVP |
| FR-COL-05 | Comments shall be attachable to any task, threaded (single-level reply is sufficient for MVP), and support @mentions. | MVP |
| FR-COL-06 | @mentions shall trigger an in-app notification immediately and an email notification (batched, max 1 per user per 5 minutes to avoid spam) if the mentioned user is offline. | MVP |
| FR-COL-07 | Every create/update/delete on Task, Dependency, Resource, Assignment, Baseline, and ProjectMember shall be recorded in an activity/audit log with actor, timestamp, before/after diff. | MVP |
| FR-COL-08 | The audit log shall be viewable (filterable by task/user/date) by Admin and Editor roles. | MVP |

### 3.8 Access Control (FR-ACL)

| ID | Requirement | Priority |
|---|---|---|
| FR-ACL-01 | The system shall enforce four project-scoped roles: Admin, Editor, Contributor, Viewer, as defined in §2. | MVP |
| FR-ACL-02 | A user may hold different roles on different projects. | MVP |
| FR-ACL-03 | Only Admins shall be able to add/remove members or change roles, delete the project, or change project-level calendars/settings. | MVP |
| FR-ACL-04 | Contributors shall be restricted server-side (not just UI-hidden) from structural edits (task/dependency create-delete, resource management). | MVP |
| FR-ACL-05 | Viewers shall receive a read-only WebSocket subscription (no mutation channel accepted from their session). | MVP |
| FR-ACL-06 | SSO/SAML is out of scope for MVP (email/password + OAuth social login is sufficient); scoped for Phase 2. | P2 |

### 3.9 Reporting & Export (FR-RPT)

| ID | Requirement | Priority |
|---|---|---|
| FR-RPT-01 | The system shall generate a burndown/burnup chart (planned vs. actual work or task count remaining, over the project timeline). | MVP |
| FR-RPT-02 | The system shall generate a cost overview report (planned vs. actual cost, by task/phase). | MVP |
| FR-RPT-03 | The system shall generate a resource utilization report (allocation % over time per resource, with overallocation periods called out). | MVP |
| FR-RPT-04 | The system shall export the Gantt chart to PDF and PNG, print-friendly (paginated for PDF), server-rendered so it doesn't depend on the client's live canvas state. | MVP |
| FR-RPT-05 | The system shall export the task grid to XLSX and CSV, including all visible/hidden columns as selected by the user. | MVP |
| FR-RPT-06 | The system shall support full project export to JSON (all entities) for backup/no-lock-in purposes at any time, self-serve. | MVP |
| FR-RPT-07 | Earned Value Management metrics (PV, EV, AC, CPI, SPI, EAC, ETC) are out of scope for MVP. | P2 |
| FR-RPT-08 | OData feed for BI tool (Power BI) connectivity is out of scope for MVP. | P2 |

### 3.10 Import/Interop (FR-IMP)

| ID | Requirement | Priority |
|---|---|---|
| FR-IMP-01 | The system shall support importing tasks from CSV/XLSX (name, duration, dates, predecessor references) with a column-mapping step. | MVP |
| FR-IMP-02 | Import of native MS Project `.mpp` files is **not** MVP (see ADR-004 in implementation plan for rationale); `.xml` (MS Project XML interchange format) import is a candidate for a fast-follow immediately after MVP given materially lower parsing complexity than binary `.mpp`. | P2 (fast-follow) |

---

## 4. Use Cases

Each use case lists actor, trigger, preconditions, main flow, and key alternate/error flows.
These map directly to acceptance-test suites.

### UC-1: Create Project & Initial WBS
- **Actor:** Project Manager (becomes Admin on creation)
- **Trigger:** User clicks "New Project"
- **Preconditions:** Authenticated user
- **Main flow:** Enter name + start date → select calendar template → project created with user as Admin → land in Grid view with one default task → user adds tasks, indents/outdents to build WBS hierarchy → dates/rollups compute automatically.
- **Alternate:** Import from CSV/XLSX instead of manual entry (→ UC-8).
- **Error:** Duplicate project name within org → allowed (names are not unique keys); invalid calendar template → falls back to default Mon–Fri.

### UC-2: Define Dependencies & Review Critical Path
- **Actor:** Project Manager / Editor
- **Trigger:** User draws a link between two Gantt bars, or sets a Predecessor cell in the grid
- **Preconditions:** Both tasks exist in the same project
- **Main flow:** User creates FS/SS/FF/SF link with optional lag → engine validates no cycle → forward/backward pass recomputes → affected task dates shift (if auto-scheduled) → critical path (Float=0 tasks) highlighted red in Gantt and flagged in grid.
- **Alternate:** User sets a Manual task's fixed date that conflicts with a new dependency → task shows a "constraint conflict" warning icon instead of moving.
- **Error:** Link would create a cycle → rejected with an inline error naming the cycle path; no partial state is committed.

### UC-3: Assign Resources & Resolve Overallocation
- **Actor:** Project Manager / Resource Manager
- **Trigger:** User assigns a resource to one or more tasks in the same period
- **Preconditions:** Resource exists with a defined calendar/capacity
- **Main flow:** Assign resource(s) with units% per task → system computes work hours and cost → if combined allocation across tasks exceeds capacity in any period, Resource Sheet flags overallocation → user clicks "Level" → system delays lower-priority tasks within available float and recomputes.
- **Alternate:** Leveling cannot fully resolve within float → system reports remaining overallocated periods and by how much; user manually adjusts (reduce units%, extend project, reassign).

### UC-4: Real-Time Collaborative Editing
- **Actor:** Two or more project members
- **Trigger:** Two users open the same project's Gantt/Grid concurrently
- **Preconditions:** Both have at least Contributor access
- **Main flow:** User A edits a task duration → change is sent to the server → server applies it through the project's ordered mutation queue → CPM recalculates → resulting state (or minimal delta) broadcasts over WebSocket to all connected clients including User B, who sees the update live with a brief highlight and A's presence cursor.
- **Alternate:** User A and User B edit the *same field* on the same task within the same round-trip → server applies in receipt order (last-write-wins on that field); the losing client gets a toast noting their change was superseded and shows the resulting value (no silent loss — the prior value is visible in the audit log).

### UC-5: Track Progress Against Baseline
- **Actor:** Project Manager
- **Trigger:** Milestone review meeting / weekly status
- **Preconditions:** A baseline has been saved
- **Main flow:** Team members update % complete / actual dates on their tasks (UC-6) → PM opens Gantt with "show baseline" toggle → sees baseline bars vs. current bars with variance in days → reviews cost overview report for planned vs. actual.

### UC-6: Team Member Updates Task Status
- **Actor:** Team Member (Contributor)
- **Trigger:** Daily/periodic check-in
- **Preconditions:** User is assigned to ≥1 task
- **Main flow:** User opens "My Tasks" filtered view → updates % complete and/or actual start/finish → rollup propagates to parent WBS tasks and, if the task is on the critical path and slips, successor dates shift and the PM sees the updated critical path live.
- **Constraint:** Contributor cannot add/remove dependencies or create/delete tasks (enforced server-side per FR-ACL-04).

### UC-7: Executive Views Read-Only Dashboard
- **Actor:** Executive/Stakeholder (Viewer)
- **Trigger:** Opens project or portfolio-lite summary link
- **Preconditions:** Viewer-role membership
- **Main flow:** Sees a dashboard: overall % complete, schedule variance, cost overview, burndown, at-risk (critical path slipping) tasks — no edit affordances rendered, and mutation endpoints reject their session server-side even if attempted directly.

### UC-8: Import Existing Schedule
- **Actor:** Project Manager
- **Trigger:** "Import" during project creation or into an existing empty project
- **Preconditions:** Source file is CSV/XLSX
- **Main flow:** Upload file → system infers columns → user maps columns to (name, duration, start, finish, predecessors, resource names) → preview with validation errors surfaced inline (bad dates, unresolved predecessor references) → confirm → tasks + dependencies created → CPM computes.

### UC-9: Generate & Export Report
- **Actor:** Project Manager / Executive
- **Trigger:** Clicks "Export" on a report or the Gantt
- **Main flow:** Select format (PDF/PNG for Gantt; XLSX/CSV for grid/reports) → server renders (headless render for Gantt PDF/PNG, query + template for XLSX/CSV) → download link returned, also emailed for large exports.

### UC-10: Manage Membership & Roles
- **Actor:** Admin
- **Trigger:** Project Settings → Members
- **Main flow:** Invite by email → set role → invitee receives email, accepts, gains scoped access → Admin can change/revoke role at any time, with immediate effect on the invitee's live session (forced permission re-check, not just next login).

---

## 5. User Journeys (Persona-Level)

### 5.1 Project Manager — first project, week one
1. Signs up, creates org/workspace.
2. Creates first project from a blank template (or imports a CSV from a prior MS Project export — UC-8).
3. Builds WBS: 3–4 phases, ~30 tasks under them, indenting to set hierarchy.
4. Adds dependencies between tasks within and across phases; reviews the critical path that appears automatically.
5. Invites 5 teammates, assigning Editor to a co-PM and Contributor to the rest.
6. Adds resources (the 5 teammates + 2 contractors), assigns them to tasks with units%; sees one overallocation flag, clicks "Level," accepts the resulting 2-day slip on a non-critical task.
7. Saves Baseline 0.
8. Shares a Viewer link with their manager.
*Success signal (ties to PRD activation metric): ≥10 tasks + 1 dependency reached inside day one, well under the 7-day target.*

### 5.2 Resource Manager — weekly capacity review
1. Opens Resource Sheet across the projects they're a member of.
2. Filters to "overallocated only."
3. For each flagged resource, opens the utilization report to see which weeks and which competing tasks are the cause.
4. Adjusts units% on lower-priority assignments or requests the PM re-level.
5. Exports the utilization report to XLSX for a staffing meeting.

### 5.3 Team Member — daily task update
1. Logs in, lands on "My Tasks" (cross-project list filtered to their assignments).
2. Marks yesterday's task 100% complete, sets actual finish date.
3. Updates today's in-progress task to 40%.
4. Sees a comment/@mention from the PM on a blocked task, replies inline.
5. Notices their update pushed a successor task's date in a live-updating mini-Gantt on the same page (no separate "publish" step — change is visible immediately to everyone).

### 5.4 Executive/Stakeholder — status check
1. Opens a shared dashboard link (Viewer role, no login friction beyond auth).
2. Scans overall % complete, schedule variance vs. baseline, and a short list of at-risk tasks (critical-path tasks with negative or shrinking float).
3. Downloads a PDF snapshot of the Gantt for a steering committee deck (UC-9).
4. Does not see edit controls anywhere in the UI, and could not mutate data even via direct API calls (role enforced server-side).

---

## 6. Data Model (Expanded)

The PRD's core entity list (`docs/PRD.md` §5.2) is sound as a starting ERD. The FRS above
implies these additions/refinements, which should be reflected in the actual schema:

```
Organization (id, name, plan_tier, created_at)
User (id, org_id, name, email, auth_provider, created_at)
Project (id, org_id, name, start_date, calendar_id, status_date, created_by, created_at)
ProjectMember (project_id, user_id, role[admin|editor|contributor|viewer], invited_at, accepted_at)

Task (id, project_id, parent_id, wbs_code, name, duration_hours, start, finish,
      pct_complete, is_milestone, schedule_mode[auto|manual], constraint_type,
      constraint_date, calendar_id, priority, status, actual_start, actual_finish,
      created_at, updated_at, updated_by)

Dependency (id, project_id, predecessor_id, successor_id, type[FS|SS|FF|SF],
            lag_hours, created_at)

Resource (id, project_id, name, type[work|material|cost], rate, rate_unit[hour|use],
          max_units_pct, calendar_id)

Assignment (id, task_id, resource_id, units_pct, work_hours, cost, effort_driven bool)

Calendar (id, project_id nullable, name, working_days[], working_hours_start,
          working_hours_end, is_default)
CalendarException (id, calendar_id, date, is_working bool, working_hours_override)

Baseline (id, project_id, name, snapshot_json, created_by, created_at)

Comment (id, task_id, user_id, body, parent_comment_id nullable, created_at)
Mention (id, comment_id, mentioned_user_id, notified_at)

Notification (id, user_id, type, payload_json, read_at, created_at)

AuditLogEntry (id, project_id, actor_user_id, entity_type, entity_id, action,
               before_json, after_json, created_at)

ExportJob (id, project_id, requested_by, type[pdf|png|xlsx|csv|json], status, file_url,
           created_at, completed_at)
```

**Indexing notes carried into the implementation plan:** `Dependency(predecessor_id)` and
`Dependency(successor_id)` both need indices for fast graph traversal in both directions;
`Task(project_id, parent_id)` for WBS tree loads; `AuditLogEntry(project_id, created_at)`
for the activity feed. The dependency graph should also be kept in an in-memory adjacency
structure per active project (in the scheduler service) rather than re-querying Postgres on
every recalculation — see the CPM engine design in the implementation plan.

---

## 7. Non-Functional Requirements (Carried Forward + Refined)

| Category | Requirement | Notes |
|---|---|---|
| Performance | Gantt initial render <1s @ 2,000 visible tasks; CPM full recalc <500ms @ 5,000 tasks; incremental recalc <150ms regardless of project size | Per PRD + FR-SCH-06 |
| Scalability | Projects up to 50,000 tasks (enterprise tier) | Requires the Gantt to virtualize rows and the CPM engine to support partial/lazy graph loading at this scale — flagged as a stretch target, not MVP-blocking (MVP target: 5,000 tasks) |
| Concurrency | Real-time multi-editor, no silent data loss | See ADR-002 |
| Availability | 99.9% uptime (paid tiers) | ~43 min/month downtime budget; needs multi-AZ DB and rolling deploys before this is a crediblecommitment |
| Security | Encryption at rest/transit, RBAC, audit log; SSO/SAML deferred to P2 | TLS everywhere, Postgres encryption at rest, secrets in a managed vault |
| Accessibility | WCAG 2.1 AA, keyboard nav for Gantt, screen-reader labels | Canvas-rendered Gantt makes this materially harder than DOM — needs a parallel accessible data-table representation kept in sync (see implementation plan risk register) |
| Browser support | Chrome, Edge, Firefox, Safari, last 2 versions | Canvas/WebGL rendering choice must be verified across all four early, not assumed |
| Data portability | Full export to XLSX/CSV/JSON at any time, self-serve | FR-RPT-06 |

---

## 8. Traceability to PRD Scope

Every MVP requirement above maps to PRD §3 (Scope — MVP); every P2-tagged requirement maps
to PRD §4 (Scope — Phase 2). No requirement was invented outside the PRD's stated scope;
this document only makes the PRD's prose testable and resolves the PRD's open questions
(§9) with explicit engineering recommendations — see `docs/IMPLEMENTATION-PLAN.md` §2 (ADRs)
for the reasoning behind each resolution.
