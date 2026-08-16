import { randomUUID } from 'node:crypto';
import { detectCycle } from '@projectapp/cpm-engine';
import {
  createDependencyRequestSchema,
  dependencyCycleDetailsSchema,
  dependencyIdParamSchema,
  mutationIntentEnvelopeSchema,
  updateDependencyRequestSchema,
} from '@projectapp/shared-types';
import type {
  CpmDependency,
  CpmScheduleInput,
  CreateDependencyRequest,
  Dependency,
} from '@projectapp/shared-types';
import type { FastifyInstance } from 'fastify';
import { auditedMutation, auditRecordsFor } from '../audit/audit-writer.js';
import { requirePermission, resolveSession } from '../auth/context.js';
import { dependencyCycle, notFound, validationFailed } from '../errors.js';
import { loadCpmScheduleInput } from '../scheduler/graph.js';
import { applyScheduleIntent, DEPENDENCY_SELECT, toDependency } from '../scheduler/rollup.js';
import type { DependencyRow } from '../scheduler/rollup.js';
import type { AppDeps } from '../app.js';

/**
 * Dependency endpoints (FR-SCH-01, FR-SCH-02, FR-SCH-03, FR-SCH-04).
 *
 * Structurally identical to `routes/tasks.ts`, for the same two reasons: no handler here writes a
 * row, and no handler here audits by hand.
 *
 *  1. **No writes, no schedule arithmetic.** A handler validates, checks RBAC, builds a
 *     `ScheduleIntent` through `mutationIntentEnvelopeSchema` and hands it to `applyScheduleIntent`
 *     — the single write path (invariant 2). A link is schedule-affecting, so an `INSERT` here
 *     would be a second path that never recomputes.
 *  2. **One audit choke point.** Every mutation runs inside `auditedMutation`, and its rows come
 *     from what the writer reports it changed (`dependencyChanges`), not from what the handler
 *     believes it asked for.
 *
 * ## What this phase does *not* do
 *
 * Creating, retyping or removing a link writes the `dependency` row and moves **no dates**. The
 * forward/backward pass that acts on a link (FR-SCH-04/05) is work item W3-1 and does not exist
 * yet; see the scope note in `apps/api/src/scheduler/rollup.ts`. A `GET /tasks` after a successful
 * `POST /dependencies` therefore returns the same dates it did before, which is current scope and
 * not a propagation bug.
 *
 * ## Cross-project ids (FR-AUTH-04)
 *
 * Three separate ids reach these handlers — the project, the two task endpoints, and (on
 * PATCH/DELETE) the link itself. Every one of them is resolved *within the project in the URL*, and
 * failing that resolution is `404 not_found`, never `403 forbidden`. `dependency.predecessor_id`
 * and `successor_id` are bare `REFERENCES task (id)`: the database cannot express "and it must be a
 * task of the same project", so a create that skipped the check below would happily link a
 * caller's task to a stranger's, and would answer differently for a real foreign id than for an
 * unused one — an existence oracle. P1's QA review found that class twice (calendar and task
 * routes) and W1-2 found it a third time on a read path, which is why it is checked explicitly
 * here and again in the writer.
 */

export function registerDependencyRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { exec, now } = deps;

  /**
   * FR-SCH-03. Refuses the create before anything is written.
   *
   * The candidate edge is handed to `detectCycle` *unpersisted*, alongside the project's real
   * tasks and links, which is precisely why `packages/cpm-engine` exposes cycle detection
   * separately from `computeSchedule` (ADR-010 §7): the answer is needed before the row exists.
   *
   * Also returns the loaded graph's task ids, because `loadCpmScheduleInput` has already selected
   * every task in the project — checking the two endpoints against that set costs nothing, whereas
   * two extra `SELECT`s for the same rows would.
   *
   * Ordering, and one thing it does not close: the graph is read before the transaction that writes
   * the row, so two concurrent creates that are each individually safe could still close a loop
   * between them. Serialising conflicting mutations per project is the ADR-002 single-writer queue,
   * which arrives at P3 in front of `applyScheduleIntent`; reading inside the transaction would not
   * fix it either, since under READ COMMITTED both snapshots would still miss the other's uncommitted
   * row. Stated here rather than left as a silent assumption.
   */
  async function assertCreateIsAcyclic(
    projectId: string,
    body: CreateDependencyRequest,
  ): Promise<void> {
    const graph: CpmScheduleInput = await loadCpmScheduleInput(exec, projectId);

    // FR-SCH-01: a link joins two tasks of the same project. Absent or foreign is `not_found`.
    const taskIds = new Set<string>(graph.tasks.map((task) => task.id));
    if (!taskIds.has(body.predecessorId)) throw notFound('Predecessor task not found');
    if (!taskIds.has(body.successorId)) throw notFound('Successor task not found');

    // The provisional id names the edge the caller just asked for. It is thrown away on rejection
    // and is *not* the id the writer will insert on success — `createDependencyIntentSchema` has no
    // `id` field, deliberately, so the writer mints its own. The only place it surfaces is
    // `cycleDependencyIds`, where it stands for "the arrow you just drew"; every other id in that
    // list is a real, persisted link the client can highlight.
    const candidate: CpmDependency = {
      id: randomUUID() as CpmDependency['id'],
      predecessorId: body.predecessorId,
      successorId: body.successorId,
      type: body.type,
      lagHours: body.lagHours,
    };

    // A self-link is the degenerate cycle, and it is answered as one — `409 dependency_cycle` with
    // `cyclePath: [a, a]` — so a client has exactly one error path to render for FR-SCH-03 rather
    // than a special case for loops of length one. It is checked here rather than left to
    // `createDependencyIntentSchema`'s refinement (which would render it `422`) or to the
    // `dependency_no_self_link` CHECK (which would render it `500`); both remain in place behind
    // this as backstops, and `detectCycle` cannot answer it — `buildGraph` discards a self-link as
    // a structurally broken edge before the walk ever sees it.
    if (body.predecessorId === body.successorId) {
      throw dependencyCycle(
        dependencyCycleDetailsSchema.parse({
          cyclePath: [body.predecessorId, body.successorId],
          cycleDependencyIds: [candidate.id],
        }),
        'A task cannot depend on itself',
      );
    }

    const diagnostic = detectCycle(graph.tasks, [...graph.dependencies, candidate]);
    if (diagnostic === null) return;

    if (diagnostic.code === 'dependency_cycle') {
      throw dependencyCycle(
        dependencyCycleDetailsSchema.parse({
          cyclePath: diagnostic.cyclePath,
          cycleDependencyIds: diagnostic.cycleDependencyIds,
        }),
      );
    }

    // Unreachable on sound data: both endpoints were just confirmed to be tasks of this project,
    // the self-link is refused above, and `dependency`'s foreign keys hold for every stored row. A
    // diagnostic here means a stored link points at a task that is not in this project — corruption
    // the caller cannot act on and must not be blamed for, so it is an internal error (rendered as
    // an opaque 500 by `app.ts`) rather than a 4xx that tells the user to fix their own request.
    throw new Error(
      `dependency graph for project ${projectId} is inconsistent: ${JSON.stringify(diagnostic)}`,
    );
  }

  /** FR-SCH-01, FR-SCH-02. */
  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/dependencies',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId } = request.params;
      // FR-ACL-04: Admin and Editor only. A Contributor's absence from this permission *is* the
      // "no structural edits" requirement, and a Viewer never reaches a mutation at all
      // (FR-ACL-05) — neither is a UI concern.
      await requirePermission(exec, user, projectId, 'dependency:write');

      const parsed = createDependencyRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationFailed(parsed.error.flatten());
      const body = parsed.data;

      await assertCreateIsAcyclic(projectId, body);

      const envelope = buildEnvelope(
        {
          kind: 'createDependency',
          projectId,
          predecessorId: body.predecessorId,
          successorId: body.successorId,
          type: body.type,
          lagHours: body.lagHours,
        },
        projectId,
        user.userId,
        now(),
      );

      const outcome = await auditedMutation(
        exec,
        { projectId, actorUserId: user.userId },
        async () => {
          const result = await applyScheduleIntent(exec, envelope);
          return { result, audit: auditRecordsFor('dependency', result.dependencyChanges) };
        },
      );

      return reply.status(201).send({ dependency: outcome.dependency });
    },
  );

  /** FR-SCH-01: every link in the project. Open to every role that can read the project. */
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/dependencies',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId } = request.params;
      await requirePermission(exec, user, projectId, 'project:read');

      const { rows } = await exec.query<DependencyRow>(
        `SELECT ${DEPENDENCY_SELECT} FROM dependency
          WHERE project_id = $1
          ORDER BY created_at, id`,
        [projectId],
      );

      return reply.status(200).send({ dependencies: rows.map(toDependency) });
    },
  );

  /**
   * FR-SCH-01, FR-SCH-02: retype or re-lag. The endpoints are not editable — moving one is a
   * different edge, so it is a DELETE plus a POST (`updateDependencyIntentSchema`).
   *
   * ## Why there is no cycle re-check here
   *
   * Whether a graph contains a cycle is a function of its edge *topology* alone. `buildGraph` keys
   * adjacency off `(predecessorId, successorId)` and `findCycle`'s walk reads only `successorId`;
   * neither reads `type` or `lagHours`. Since this endpoint cannot change an endpoint id, no
   * accepted body can turn an acyclic graph cyclic — including `SF`, which is an ordinary
   * predecessor -> successor edge to the graph builder whatever it means to the scheduling pass,
   * and including a large negative lag, which shifts dates but adds no arrow. That is asserted
   * rather than assumed: see `dependencies.test.ts`, "cycle-ness is a property of the edge set".
   */
  app.patch<{ Params: { projectId: string; dependencyId: string } }>(
    '/projects/:projectId/dependencies/:dependencyId',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId } = request.params;
      await requirePermission(exec, user, projectId, 'dependency:write');

      const dependencyId = parseDependencyId(request.params);

      const parsed = updateDependencyRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationFailed(parsed.error.flatten());
      const body = parsed.data;

      const envelope = buildEnvelope(
        {
          kind: 'updateDependency',
          dependencyId,
          ...(body.type === undefined ? {} : { type: body.type }),
          ...(body.lagHours === undefined ? {} : { lagHours: body.lagHours }),
        },
        projectId,
        user.userId,
        now(),
      );

      const outcome = await auditedMutation(
        exec,
        { projectId, actorUserId: user.userId },
        async () => {
          const result = await applyScheduleIntent(exec, envelope);
          return { result, audit: auditRecordsFor('dependency', result.dependencyChanges) };
        },
      );

      return reply.status(200).send({ dependency: outcome.dependency });
    },
  );

  /**
   * FR-SCH-04. Removing a link is as schedule-affecting as adding one — it is audited identically
   * and, once W3-1 lands, will trigger the same recompute. Deleting a link that never existed and
   * deleting one that belongs to another project are the same answer, 404.
   */
  app.delete<{ Params: { projectId: string; dependencyId: string } }>(
    '/projects/:projectId/dependencies/:dependencyId',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId } = request.params;
      await requirePermission(exec, user, projectId, 'dependency:write');

      const dependencyId = parseDependencyId(request.params);

      const envelope = buildEnvelope(
        { kind: 'deleteDependency', dependencyId },
        projectId,
        user.userId,
        now(),
      );

      await auditedMutation(exec, { projectId, actorUserId: user.userId }, async () => {
        const result = await applyScheduleIntent(exec, envelope);
        return { result, audit: auditRecordsFor('dependency', result.dependencyChanges) };
      });

      return reply.status(204).send();
    },
  );
}

/**
 * A malformed dependency id cannot match any row, so it is `not_found` exactly like a well-formed
 * but absent one — no id *shape* leaks information either (FR-AUTH-04), and a raw uuid cast
 * reaching Postgres would render as a 500 instead.
 */
function parseDependencyId(params: { dependencyId: string }): Dependency['id'] {
  const parsed = dependencyIdParamSchema.safeParse(params);
  if (!parsed.success) throw notFound('Dependency not found');
  return parsed.data.dependencyId;
}

/**
 * Validates the intent against its own contract on the way out of the HTTP layer, exactly as
 * `routes/tasks.ts` does. The route params are the source of `projectId` and `dependencyId` (never
 * a client-supplied body field), and `issuedAt` is the API's clock (`intents.ts`).
 *
 * Since contract 0.4.0 this schema accepts dependency intents; before the rebind that landed with
 * this file, every call below would have failed validation.
 */
function buildEnvelope(
  intent: unknown,
  projectId: string,
  actorUserId: string,
  issuedAt: Date,
): ReturnType<typeof mutationIntentEnvelopeSchema.parse> {
  const parsed = mutationIntentEnvelopeSchema.safeParse({
    intent,
    projectId,
    actorUserId,
    issuedAt: issuedAt.toISOString(),
  });
  if (!parsed.success) throw validationFailed(parsed.error.flatten());
  return parsed.data;
}
