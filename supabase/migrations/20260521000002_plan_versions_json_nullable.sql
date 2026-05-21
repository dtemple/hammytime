-- plan_json is null until the athlete pastes their plan back (status = 'awaiting_paste')
alter table plan_versions alter column plan_json drop not null;
