-- Working/baseline split for in-conversation plan edits.
--
-- The coach can now edit the plan in chat (see worker/plan-version.ts). Each
-- edit creates a new active plan_versions row and repoints
-- plans.current_version_id — the "working" plan the calendar feed renders.
-- baseline_version_id anchors the original plan of record so we can measure how
-- far the working plan has drifted from it. Edits move current_version_id;
-- baseline_version_id only moves on a deliberate re-plan (not wired yet).

alter table plans
  add column baseline_version_id uuid references plan_versions(id);

-- Existing athletes: their current plan becomes their baseline.
update plans
set baseline_version_id = current_version_id
where baseline_version_id is null
  and current_version_id is not null;

-- Allow coach-authored versions in the generated_by ledger.
alter table plan_versions
  drop constraint plan_versions_generated_by_check;

alter table plan_versions
  add constraint plan_versions_generated_by_check
  check (generated_by in ('athlete_llm', 'manual', 'claude_v2', 'coach_agent'));
