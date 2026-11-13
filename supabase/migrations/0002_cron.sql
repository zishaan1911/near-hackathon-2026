-- Schedules the serverless tick (publish, settle, roll, match) once a minute.
-- Vercel Hobby cannot run per-minute crons, so Supabase pg_cron + pg_net call
-- the deployed endpoint instead.
--
-- Before applying, the operator must run (placeholders only; use your real
-- deployment URL and the same value as the Vercel CRON_SECRET):
--
--   alter database postgres set app.settings.tick_url = 'https://<deployment>/api/v1/cron/tick';
--   alter database postgres set app.settings.cron_secret = '<same value as Vercel CRON_SECRET>';
--
-- Re-running: the unschedule below removes any previous job of the same name.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

do $$
begin
  perform cron.unschedule('silica-tick');
exception when others then
  null; -- no existing job
end
$$;

-- The job's earlier name, removed so a re-run cannot leave a duplicate.
do $$
begin
  perform cron.unschedule('congest-tick');
exception when others then
  null;
end
$$;

select cron.schedule(
  'silica-tick',
  '* * * * *',
  $$ select net.http_post(
       url := current_setting('app.settings.tick_url'),
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || current_setting('app.settings.cron_secret'),
         'Content-Type', 'application/json'
       ),
       body := '{}'::jsonb,
       timeout_milliseconds := 55000
     ) $$
);
