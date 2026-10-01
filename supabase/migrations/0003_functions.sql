-- ============================================================================
--  0003_functions.sql — triggers, helper functions, views, realtime, storage
-- ============================================================================

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare
  t text;
  tables text[] := array['profiles','organizations','projects','recipes','jobs',
                         'records','monitors','webhooks'];
begin
  foreach t in array tables loop
    execute format('drop trigger if exists trg_%s_touch on public.%I', t, t);
    execute format(
      'create trigger trg_%s_touch before update on public.%I
         for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Signup bootstrap: profile + personal org + owner membership.
-- Accepting any pending invitations happens here too, so an invited teammate
-- lands in the right workspace on first login.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_name   text;
  v_slug   text;
  v_local  text;
  v_inv    record;
begin
  v_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    split_part(coalesce(new.email, 'user'), '@', 1)
  );

  insert into public.profiles (id, email, full_name, avatar_url)
  values (new.id, new.email, v_name, new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;

  -- Collision-resistant slug: base from the email local-part, suffixed until free.
  v_local := trim(both '-' from regexp_replace(lower(split_part(coalesce(new.email, 'user'), '@', 1)), '[^a-z0-9]+', '-', 'g'));
  if char_length(v_local) < 3 then
    v_local := 'user';
  end if;
  v_local := left(v_local, 40);
  v_slug  := v_local;
  while exists (select 1 from public.organizations where slug = v_slug) loop
    v_slug := v_local || '-' || substr(replace(new.id::text, '-', ''), 1, 6);
  end loop;

  insert into public.organizations (name, slug)
  values (v_name || '''s workspace', v_slug)
  returning id into v_org_id;

  insert into public.org_members (org_id, user_id, role)
  values (v_org_id, new.id, 'owner')
  on conflict do nothing;

  -- Fold any pending invitations into the new account.
  for v_inv in
    select id, org_id, role from public.invitations
    where accepted_at is null and expires_at > now() and lower(email) = lower(coalesce(new.email, ''))
  loop
    insert into public.org_members (org_id, user_id, role)
    values (v_inv.org_id, new.id, v_inv.role)
    on conflict (org_id, user_id) do nothing;

    update public.invitations set accepted_at = now() where id = v_inv.id;
  end loop;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Run bookkeeping
--   * run_number is assigned server-side so concurrent enqueues can't collide
--   * the log tail is capped so a chatty crawl can't bloat the row
-- ---------------------------------------------------------------------------
create or replace function public.create_job_run(
  p_job_id uuid,
  p_trigger run_trigger default 'manual',
  p_triggered_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_next   int;
  v_org    uuid;
begin
  select org_id into v_org from public.jobs where id = p_job_id;
  if v_org is null then
    raise exception 'job % not found', p_job_id using errcode = 'no_data_found';
  end if;

  -- Serialise numbering per job.
  perform pg_advisory_xact_lock(hashtext(p_job_id::text));

  select coalesce(max(run_number), 0) + 1 into v_next
  from public.job_runs where job_id = p_job_id;

  insert into public.job_runs (job_id, org_id, run_number, status, trigger, triggered_by, started_at)
  values (p_job_id, v_org, v_next, 'running', p_trigger, p_triggered_by, now())
  returning id into v_run_id;

  update public.jobs
     set status = 'running', last_run_at = now(), run_count = coalesce(run_count, 0) + 1
   where id = p_job_id;

  return v_run_id;
end $$;

create or replace function public.append_run_log(
  p_run_id uuid,
  p_entry jsonb,
  p_max_entries int default 200
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.job_runs
     set log = (
       case
         when jsonb_array_length(log) >= p_max_entries
           then log - 0                      -- drop the oldest line
         else log
       end
     ) || jsonb_build_array(p_entry)
   where id = p_run_id;
$$;

-- Called by the worker once a run finishes: finalises the run and rolls the
-- summary up onto the job so the dashboard never has to aggregate on read.
create or replace function public.finalize_job_run(
  p_run_id uuid,
  p_status run_status,
  p_error_code text default null,
  p_error_message text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job uuid;
  v_org uuid;
begin
  update public.job_runs
     set status = p_status,
         finished_at = now(),
         duration_ms = coalesce(duration_ms,
                       (extract(epoch from (now() - coalesce(started_at, now()))) * 1000)::int),
         error_code = coalesce(p_error_code, error_code),
         error_message = coalesce(left(p_error_message, 2000), error_message)
   where id = p_run_id
   returning job_id, org_id into v_job, v_org;

  if v_job is null then
    return;
  end if;

  update public.jobs j
     set status = case
                    when p_status in ('succeeded') then 'succeeded'::job_status
                    when p_status in ('partial')   then 'partial'::job_status
                    when p_status in ('failed', 'timeout') then 'failed'::job_status
                    when p_status = 'cancelled'    then 'cancelled'::job_status
                    else j.status
                  end,
         record_count = (select count(*) from public.records where job_id = j.id),
         stats = j.stats || jsonb_build_object(
           'lastRunId', p_run_id,
           'lastStatus', p_status::text,
           'lastDurationMs', (select duration_ms from public.job_runs where id = p_run_id),
           'lastPagesOk', (select pages_ok from public.job_runs where id = p_run_id)
         ),
         updated_at = now()
   where j.id = v_job;
end $$;

revoke all on function public.create_job_run(uuid, run_trigger, uuid) from public;
revoke all on function public.append_run_log(uuid, jsonb, int) from public;
revoke all on function public.finalize_job_run(uuid, run_status, text, text) from public;
grant execute on function public.create_job_run(uuid, run_trigger, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Quota & usage helpers
-- ---------------------------------------------------------------------------
create or replace function public.org_ai_tokens_this_month(p_org_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(quantity), 0)
  from public.usage_events
  where org_id = p_org_id
    and kind = 'ai_tokens'
    and occurred_at >= date_trunc('month', now());
$$;

create or replace function public.org_pages_used_since(p_org_id uuid, p_since timestamptz)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*) from public.pages where org_id = p_org_id and created_at >= p_since;
$$;

-- ---------------------------------------------------------------------------
-- Scheduling view: the scheduler polls this instead of scanning jobs.
--
-- `security_invoker = true` (PostgreSQL 15+) makes a view run with the
-- *caller's* privileges, so RLS on `jobs` still applies. Without it a view is
-- evaluated as its owner (the migration role) and every tenant would see every
-- other tenant's schedules — Supabase flags exactly this as
-- "security definer view".
-- ---------------------------------------------------------------------------
create or replace view public.due_scheduled_jobs with (security_invoker = true) as
  select j.id, j.org_id, j.name, j.mode, j.next_run_at, j.schedule_cron, j.schedule_tz
  from public.jobs j
  where j.schedule_enabled
    and j.status <> 'cancelled'
    and j.schedule_cron is not null
    and coalesce(j.next_run_at, now()) <= now()
  order by j.next_run_at asc
  limit 100;

-- ---------------------------------------------------------------------------
-- Dashboard views
-- ---------------------------------------------------------------------------
create or replace view public.v_job_overview with (security_invoker = true) as
  select
    j.id, j.org_id, j.name, j.mode, j.status, j.tags, j.schedule_enabled,
    j.created_at, j.last_run_at, j.record_count,
    r.status        as last_run_status,
    r.duration_ms   as last_duration_ms,
    r.records_count as last_records,
    r.records_new   as last_new,
    r.records_changed as last_changed,
    r.pages_ok      as last_pages_ok,
    r.pages_failed  as last_pages_failed,
    (select count(*) from public.job_runs x where x.job_id = j.id) as run_count
  from public.jobs j
  left join lateral (
    select * from public.job_runs jr
    where jr.job_id = j.id
    order by jr.run_number desc
    limit 1
  ) r on true;

create or replace view public.v_org_daily_usage with (security_invoker = true) as
  select
    org_id,
    date_trunc('day', occurred_at) as day,
    kind,
    sum(quantity)                 as quantity,
    sum(quantity * unit_cost_usd) as cost_usd
  from public.usage_events
  group by org_id, date_trunc('day', occurred_at), kind;

-- ---------------------------------------------------------------------------
-- Realtime: the UI subscribes to these instead of polling.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['jobs', 'job_runs', 'pages', 'records', 'alert_events'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;   -- already published
      when undefined_object then null;   -- publication doesn't exist (non-Supabase PG)
    end;
  end loop;
end $$;

-- Update payloads must carry the full new row for the UI to patch in place.
alter table public.jobs      replica identity full;
alter table public.job_runs  replica identity full;
alter table public.pages     replica identity full;

-- ---------------------------------------------------------------------------
-- Storage: one bucket for crawled artifacts, one for generated exports.
-- Object path convention:  <org_id>/<job_id>/<run_id>/<sha>.html
-- The first path segment is what the policies below key on, so a signed URL
-- for one tenant can never address another tenant's object.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('artifacts', 'artifacts', false, 26214400,
   array['text/html','application/json','image/png','image/jpeg','text/markdown','text/plain']),
  ('exports',   'exports',   false, 1073741824,
   array['text/csv','application/json','application/x-ndjson','application/zip'])
on conflict (id) do nothing;

drop policy if exists artifacts_read_member on storage.objects;
create policy artifacts_read_member on storage.objects
  for select to authenticated using (
    bucket_id in ('artifacts', 'exports')
    and public.is_org_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists artifacts_write_member on storage.objects;
create policy artifacts_write_member on storage.objects
  for insert to authenticated with check (
    bucket_id in ('artifacts', 'exports')
    and public.can_write(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists artifacts_delete_writer on storage.objects;
create policy artifacts_delete_writer on storage.objects
  for delete to authenticated using (
    bucket_id in ('artifacts', 'exports')
    and public.can_write(((storage.foldername(name))[1])::uuid)
  );

-- ---------------------------------------------------------------------------
-- Retention: called nightly by pg_cron (or an Edge Function) to enforce the
-- per-project retention window. Data minimisation is a compliance requirement,
-- not an optimisation.
-- ---------------------------------------------------------------------------
create or replace function public.purge_expired_artifacts()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_page_ids uuid[];
  v_count int;
begin
  select array_agg(p.id) into v_page_ids
  from public.pages p
  join public.jobs j on j.id = p.job_id
  join public.projects pr on pr.id = j.project_id
  where pr.retention_days > 0
    and p.created_at < now() - make_interval(days => pr.retention_days)
    and (p.artifact_html_path is not null or p.markdown is not null)
  limit 10000;

  if v_page_ids is null then
    return 0;
  end if;

  -- Drop the uploaded artifacts, then the inline copies.
  delete from storage.objects
   where bucket_id = 'artifacts'
     and name in (select artifact_html_path from public.pages where id = any (v_page_ids) and artifact_html_path is not null)
        or (bucket_id = 'artifacts' and name in (select artifact_screenshot_path from public.pages where id = any (v_page_ids) and artifact_screenshot_path is not null));

  update public.pages
     set markdown = null, artifact_html_path = null, artifact_screenshot_path = null
   where id = any (v_page_ids);
  get diagnostics v_count = row_count;

  return v_count;
end $$;
