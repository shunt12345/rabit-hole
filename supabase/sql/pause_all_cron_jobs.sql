-- Pause every scheduled job (pg_cron) without deleting it. Each job keeps
-- its schedule and command, and simply stops firing until it is switched
-- back on. Run in the Supabase SQL editor; it ends by listing every job
-- and whether it is active.
--
-- Jobs this pauses (from the migrations): generate-trending-topics,
-- generate-trending-topics-special, auto-approve-pending-trending-topics,
-- generate-hyfax-chains, send-daily-digest, precompute-hero-pages.
--
-- To turn them all back on later, run the same statement with
-- active := true.
select cron.alter_job(jobid, active := false) from cron.job;

select jobid, jobname, schedule, active from cron.job order by jobid;
