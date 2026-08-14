# Product Requirements Document: [ProjectApp]
**Version:** 0.1 | **Status:** Draft | **Owner:** Hai

---

## 1. Overview

**Problem:** MS Project is expensive ($10-55/user/mo), desktop-heavy (Standard/Pro), steep learning curve, weak real-time collaboration, poor modern UX. Target: web-native project scheduling tool with Gantt/CPM core, better collaboration, lower cost.

**Vision:** Browser-based project management app supporting Gantt scheduling, resource management, critical path analysis, and team collaboration — MS Project feature parity for core scheduling, better UX/collab for mid-market teams (10-500 employees).

**Non-goals (v1):** Portfolio/PPM (multi-project rollups), enterprise resource pooling across orgs, VBA/macro scripting, offline desktop client.

---

## 2. Target Users & Personas

| Persona | Role | Core Need |
|---|---|---|
| Project Manager | Plans/tracks schedule | Gantt editing, dependencies, critical path, baseline variance |
| Resource Manager | Allocates people | Capacity view, overallocation alerts, utilization reports |
| Team Member | Executes tasks | Task list, % complete update, timesheet |
| Executive/Stakeholder | Monitors | Dashboard, EVM metrics, status reports (read-only) |

---

## 3. Scope — MVP (Phase 1)

### 3.1 Scheduling Engine
- Task CRUD: name, duration, start/end, % complete, notes
- WBS hierarchy (parent/child tasks, auto-rollup of dates/duration/% complete)
- Dependencies: FS, SS, FF, SF with lag/lead (+/- days)
- Auto-scheduling: forward/backward pass, critical path calculation (CPM algorithm)
- Manual scheduling mode (fixed dates, no auto-shift)
- Milestones (zero-duration tasks)
- Task calendars (working days/hours override at task level)
- Constraint types: ASAP, ALAP, Must Start On, Must Finish On, Start No Earlier Than, etc.

### 3.2 Resource Management
- Resource types: Work (people), Material, Cost
- Resource assignment to tasks with units % (e.g., 50% allocated)
- Resource calendar (working hours, holidays, PTO)
- Overallocation detection + visual flag
- Basic leveling (delay tasks to resolve overallocation, priority-based)
- Cost calculation: (work hours × rate) + material cost + fixed cost

### 3.3 Views
- Gantt Chart (drag to resize/move, dependency lines, critical path highlight in red)
- Task Grid/Sheet (spreadsheet-style, sortable/filterable columns)
- Resource Sheet (list + allocation %)
- Calendar view (month/week task view)
- Kanban board (status-based, optional per-project toggle)

### 3.4 Tracking
- Baseline save/compare (baseline vs actual dates, variance in days)
- % complete rollup (weighted by duration or manual)
- Status date, actual start/finish capture

### 3.5 Collaboration
- Multi-user real-time editing (CRDT or OT-based, like Google Sheets)
- Comments on tasks
- @mentions + notifications (in-app, email)
- Activity log/audit trail
- Role-based access: Admin, Editor, Contributor (task update only), Viewer

### 3.6 Reporting
- Burndown/burnup chart
- Cost overview (planned vs actual)
- Resource utilization report
- Export: PDF, PNG (Gantt), Excel, CSV
- Print-friendly Gantt

---

## 4. Scope — Phase 2 (Post-MVP)

- Earned Value Management: PV, EV, AC, CPI, SPI, EAC, ETC formulas built-in
- Portfolio view: cross-project rollup, program-level Gantt
- Timesheet submission/approval workflow
- Custom fields + formula fields (like MS Project custom fields)
- API (REST + webhooks) for integrations
- Power BI / BI tool connector (OData feed)
- Mobile app (iOS/Android) — task update, notifications
- Recurring tasks
- Master project / subproject linking
- What-if scenario branching (duplicate schedule, compare)
- SSO/SAML, audit compliance (SOC 2 scope)

---

## 5. Functional Requirements Detail

### 5.1 Critical Path Algorithm
- Input: task list with duration, dependencies, calendars
- Forward pass: Early Start (ES), Early Finish (EF) = ES + duration
- Backward pass: Late Finish (LF), Late Start (LS) = LF − duration
- Slack/Float = LS − ES; Critical path = tasks where Float = 0
- Recalculate on: task edit, dependency change, calendar change
- Perf target: <500ms recalculation for 5,000-task project

### 5.2 Data Model (Core Entities)

```
Project (id, name, start_date, calendar_id, status_date)
Task (id, project_id, parent_id, name, duration, start, finish,
      pct_complete, constraint_type, constraint_date, is_milestone,
      wbs_code, priority)
Dependency (id, predecessor_id, successor_id, type[FS|SS|FF|SF], lag_days)
Resource (id, name, type[work|material|cost], rate, max_units, calendar_id)
Assignment (id, task_id, resource_id, units_pct, work_hours)
Calendar (id, name, working_days[], working_hours, exceptions[])
Baseline (id, project_id, name, snapshot_json, created_at)
User (id, name, email, role)
ProjectMember (project_id, user_id, role[admin|editor|contributor|viewer])
Comment (id, task_id, user_id, body, created_at)
```

### 5.3 Non-Functional Requirements

| Category | Requirement |
|---|---|
| Performance | Gantt render <1s for 2,000 visible tasks; CPM recalc <500ms/5k tasks |
| Scalability | Support projects up to 50,000 tasks (enterprise tier) |
| Concurrency | Real-time multi-editor, conflict resolution via OT/CRDT, no data loss |
| Availability | 99.9% uptime SLA (paid tiers) |
| Security | Encryption at rest/transit, RBAC, SSO (Phase 2), audit log |
| Accessibility | WCAG 2.1 AA (keyboard nav for Gantt, screen reader labels) |
| Browser support | Chrome, Edge, Firefox, Safari (last 2 versions) |
| Data export | No lock-in — full export to XLSX/CSV/JSON at any time |

---

## 6. Technical Architecture (Recommended)

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | React + TypeScript | Component reuse for Gantt/grid widgets |
| Gantt rendering | Canvas/WebGL (custom) or lib (Bryntum, DHTMLX, or build on `svar-gantt`/`frappe-gantt` fork) | DOM-based Gantt breaks >1k tasks; canvas scales |
| State sync | CRDT (Yjs) or OT | Real-time multi-user editing without conflicts |
| Backend | Node.js/TypeScript or Go | CPM scheduling is CPU-bound; Go/Rust better at scale |
| DB | PostgreSQL | Relational integrity for dependency graph; JSONB for flexible fields |
| Scheduling engine | Custom CPM service (stateless, recalc-on-write) | Core differentiator — must be correct & fast |
| Real-time transport | WebSocket (Socket.io or native) | Live collaboration |
| Reporting/BI | Materialized views + OData endpoint (Phase 2) | Power BI/Excel compatibility |
| Infra | Containerized (Docker/K8s), cloud-agnostic | Avoid vendor lock-in |

**Key technical risk:** CPM recalculation at scale with real-time collaboration is the hardest problem — every edit potentially triggers a full dependency graph re-traversal. Mitigate with incremental recalculation (only affected subgraph, topological sort from changed node) rather than full recompute.

---

## 7. Competitive Differentiation

| Dimension | MS Project | This Product |
|---|---|---|
| Deployment | Desktop-first, cloud add-on | Web-native, no install |
| Collaboration | Limited (Project Online only) | Real-time multi-editor by default |
| Pricing | $10-55/user/mo | TBD — target lower, transparent |
| Learning curve | High | Simplified onboarding, templates |
| API/extensibility | Limited (VBA, Graph API) | REST API + webhooks (Phase 2) |
| Mobile | Weak | Native app (Phase 2) |

---

## 8. Success Metrics

- Activation: % of new projects with ≥10 tasks + 1 dependency within 7 days
- Engagement: weekly active editors per project
- Retention: 90-day project retention rate
- Performance: p95 Gantt load time, p95 CPM recalc time
- NPS from PM personas

---

## 9. Open Questions / Assumptions to Validate

- [ ] Pricing model: per-seat vs per-project vs flat org tier
- [ ] Target org size for v1 GA (SMB vs mid-market)
- [ ] Build custom Gantt renderer vs license (Bryntum ~$1-2k/dev, DHTMLX similar) — buy vs build tradeoff for MVP speed
- [ ] Real-time collab: Yjs (open-source CRDT) vs custom OT — recommend Yjs for MVP speed
- [ ] Import compatibility: MS Project .mpp file import required for adoption? (high complexity — proprietary binary/XML format)

---

## 10. Milestones (Suggested)

| Phase | Scope | Est. Duration |
|---|---|---|
| M1 | Task CRUD, WBS, basic Gantt (no deps) | 4-6 wks |
| M2 | Dependencies + CPM engine + critical path | 4-6 wks |
| M3 | Resources, assignments, cost calc | 3-4 wks |
| M4 | Real-time collab (Yjs integration) | 4-6 wks |
| M5 | Baselines, tracking, reporting | 3-4 wks |
| M6 | RBAC, comments, notifications | 2-3 wks |
| Beta | Internal dogfood + pilot customers | 4 wks |

*Estimates assume 1-2 full-stack engineers; scale accordingly.*
