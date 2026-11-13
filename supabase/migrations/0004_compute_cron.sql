-- Schedules the SCI snapshot every 15 minutes via Supabase pg_cron + pg_net
-- calling the deployed endpoint (see 0002_cron.sql for the tick job).
--
-- Before applying, the operator must run (placeholders only; use your real
-- deployment URL and the same value as the Vercel CRON_SECRET; the
-- app.settings.cron_secret setting from 0002_cron.sql is reused):
--
--   alter database postgres set app.settings.compute_snapshot_url = 'https://<deployment>/api/v1/cron/compute-snapshot';
--   alter database postgres set app.settings.cron_secret = '<same value as Vercel CRON_SECRET>';
--
-- Re-running: the unschedule below removes any previous job of the same name.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

do $$
begin
  perform cron.unschedule('silica-compute-snapshot');
exception when others then
  null; -- no existing job
end
$$;

-- The job's earlier name, removed so a re-run cannot leave a duplicate.
do $$
begin
  perform cron.unschedule('congest-compute-snapshot');
exception when others then
  null;
end
$$;

select cron.schedule(
  'silica-compute-snapshot',
  '*/15 * * * *',
  $$ select net.http_post(
       url := current_setting('app.settings.compute_snapshot_url'),
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || current_setting('app.settings.cron_secret'),
         'Content-Type', 'application/json'
       ),
       body := '{}'::jsonb,
       timeout_milliseconds := 55000
     ) $$
);
