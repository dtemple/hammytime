-- Onboarding v2 W4: template-generated plans.
--
-- The deterministic template renderer (src/lib/plan-templates) produces the
-- athlete's first plan inline on the bot path during onboarding. That version
-- becomes both the immutable baseline and the initial working version. Record
-- its provenance in the generated_by ledger alongside the existing values
-- ('coach_agent' was added in 20260602000000_plan_baseline_version).

alter table plan_versions
  drop constraint plan_versions_generated_by_check;

alter table plan_versions
  add constraint plan_versions_generated_by_check
  check (generated_by in ('athlete_llm', 'manual', 'claude_v2', 'coach_agent', 'template'));
