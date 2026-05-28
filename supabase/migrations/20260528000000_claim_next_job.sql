-- Atomic single-job claim for the Fly.io worker (M1 plan §3.2).
-- Uses FOR UPDATE SKIP LOCKED so concurrent workers never grab the same row.
-- A row whose lock is older than p_stale_minutes is reclaimable, so a crashed
-- worker's in-flight jobs don't strand. Returns the claimed row, or NULL when
-- nothing is due.
create or replace function claim_next_job(p_stale_minutes int default 15)
returns job_queue
language plpgsql as $$
declare
  claimed job_queue;
begin
  update job_queue
     set locked_at = now(),
         attempts  = attempts + 1
   where id = (
     select id from job_queue
      where completed_at is null
        and run_after <= now()
        and (locked_at is null or locked_at < now() - make_interval(mins => p_stale_minutes))
      order by run_after
      for update skip locked
      limit 1
   )
  returning * into claimed;

  return claimed;
end;
$$;
