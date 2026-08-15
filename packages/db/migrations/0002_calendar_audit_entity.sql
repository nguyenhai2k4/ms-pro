-- 0002_calendar_audit_entity.sql — P1 entry: calendars become an audited entity type.
--
-- FR-COL-07 / invariant 4 (CLAUDE.md): every schedule-affecting mutation writes an audit log
-- entry. P1 adds calendar CRUD (FR-CAL-01..04), which 0001_init.sql's audit_entity_type did not
-- anticipate. Migrations are forward-only and never edited after merge, so this adds the value
-- rather than changing 0001.
--
-- The new label is not used by this migration itself — PostgreSQL disallows using an
-- ALTER TYPE ... ADD VALUE label in the same transaction that added it.

ALTER TYPE audit_entity_type ADD VALUE 'calendar';
