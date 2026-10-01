-- ============================================================================
--  0002_rls.sql — Row Level Security
--
--  Rules of engagement:
--    * RLS is ENABLED and FORCED on every table (FORCE also binds the table
--      owner, so a mis-scoped query as `postgres` still hits the policies).
--    * Reads require membership; writes additionally require a sufficient role.
--    * Every write policy uses WITH CHECK, so a member cannot re-parent a row
--      into another org.
--    * Helper functions are SECURITY DEFINER with a pinned search_path so they
--      cannot be hijacked by a temporary-schema attack.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Membership helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = auth.uid()
  );
$$;

-- Roles are cumulative: owner ⊃ admin ⊃ member ⊃ viewer.
create or replace function public.has_org_role(p_org_id uuid, p_roles org_role[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
      and m.role = any (p_roles)
  );
$$;

-- Can create / edit / delete jobs, recipes, webhooks, monitors.
create or replace function public.can_write(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_org_role(p_org_id, array['owner','admin','member']::org_role[]);
$$;

-- Can manage members, keys, billing.
create or replace function public.can_admin(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_org_role(p_org_id, array['owner','admin']::org_role[]);
$$;

revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.has_org_role(uuid, org_role[]) from public;
revoke all on function public.can_write(uuid) from public;
revoke all on function public.can_admin(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.has_org_role(uuid, org_role[]) to authenticated;
grant execute on function public.can_write(uuid) to authenticated;
grant execute on function public.can_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- profiles — a user may only see and edit their own row
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.profiles force row level security;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- Teammates' names/avatars are visible only if you share an org.
drop policy if exists profiles_select_coworkers on public.profiles;
create policy profiles_select_coworkers on public.profiles
  for select to authenticated using (
    exists (
      select 1
      from public.org_members me
      join public.org_members them on them.org_id = me.org_id
      where me.user_id = auth.uid() and them.user_id = profiles.id
    )
  );

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.organizations force row level security;

drop policy if exists org_select_member on public.organizations;
create policy org_select_member on public.organizations
  for select to authenticated using (public.is_org_member(id));

drop policy if exists org_update_admin on public.organizations;
create policy org_update_admin on public.organizations
  for update to authenticated
  using (public.can_admin(id)) with check (public.can_admin(id));

drop policy if exists org_insert_self on public.organizations;
create policy org_insert_self on public.organizations
  for insert to authenticated with check (true);  -- membership row is created by trigger

drop policy if exists org_delete_owner on public.organizations;
create policy org_delete_owner on public.organizations
  for delete to authenticated using (public.has_org_role(id, array['owner']::org_role[]));

-- ---------------------------------------------------------------------------
-- org_members
-- ---------------------------------------------------------------------------
alter table public.org_members enable row level security;
alter table public.org_members force row level security;

drop policy if exists members_select on public.org_members;
create policy members_select on public.org_members
  for select to authenticated using (public.is_org_member(org_id));

drop policy if exists members_insert_admin on public.org_members;
create policy members_insert_admin on public.org_members
  for insert to authenticated with check (public.can_admin(org_id));

drop policy if exists members_update_admin on public.org_members;
create policy members_update_admin on public.org_members
  for update to authenticated
  using (public.can_admin(org_id)) with check (public.can_admin(org_id));

-- Owners cannot remove themselves via this policy (prevents orphaned orgs).
drop policy if exists members_delete_admin on public.org_members;
create policy members_delete_admin on public.org_members
  for delete to authenticated using (
    public.can_admin(org_id) and not (user_id = auth.uid() and role = 'owner')
  );

-- ---------------------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------------------
alter table public.invitations enable row level security;
alter table public.invitations force row level security;

drop policy if exists invitations_admin on public.invitations;
create policy invitations_admin on public.invitations
  for all to authenticated
  using (public.can_admin(org_id)) with check (public.can_admin(org_id));

-- The invitee can see (and later accept) their own invitation by email.
drop policy if exists invitations_invitee_select on public.invitations;
create policy invitations_invitee_select on public.invitations
  for select to authenticated using (
    email = (select email from public.profiles where id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Standard tenant tables
--   select  : any member
--   insert  : writer
--   update  : writer
--   delete  : writer
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  tenant_tables text[] := array[
    'projects', 'recipes', 'jobs', 'job_runs', 'pages', 'records',
    'monitors', 'alert_events', 'proxies', 'webhooks', 'webhook_deliveries',
    'usage_events', 'audit_logs'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    execute format('drop policy if exists %I on public.%I', t || '_select_member', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_org_member(org_id))',
      t || '_select_member', t);

    execute format('drop policy if exists %I on public.%I', t || '_insert_writer', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.can_write(org_id))',
      t || '_insert_writer', t);

    execute format('drop policy if exists %I on public.%I', t || '_update_writer', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.can_write(org_id)) with check (public.can_write(org_id))',
      t || '_update_writer', t);

    execute format('drop policy if exists %I on public.%I', t || '_delete_writer', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.can_write(org_id))',
      t || '_delete_writer', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- api_keys — admins manage; nobody (including admins) can read the hash back
-- through the API surface. Column-level grants do the redaction.
-- ---------------------------------------------------------------------------
alter table public.api_keys enable row level security;
alter table public.api_keys force row level security;

drop policy if exists api_keys_admin_all on public.api_keys;
create policy api_keys_admin_all on public.api_keys
  for all to authenticated
  using (public.can_admin(org_id)) with check (public.can_admin(org_id));

-- Belt and braces: even an admin's SELECT cannot return the hash column.
revoke select on public.api_keys from authenticated;
grant select (id, org_id, name, prefix, scopes, last_used_at, request_count,
              expires_at, revoked_at, created_by, created_at)
  on public.api_keys to authenticated;

-- Same treatment for webhook signing secrets: the column is excluded from the
-- grant so no browser session can read it, whatever its role.
revoke select on public.webhooks from authenticated;
grant select (id, org_id, url, description, events, is_active, created_by,
              created_at, updated_at)
  on public.webhooks to authenticated;

-- Proxy credentials are encrypted, but there is still no reason to ship the
-- ciphertext to a browser.
revoke select on public.proxies from authenticated;
grant select (id, org_id, label, kind, country, is_active, last_checked_at,
              last_error, success_count, failure_count, created_at)
  on public.proxies to authenticated;

-- Records/pages hold third-party content: viewers get read-only, and the raw
-- artifacts are served through signed URLs only.
revoke all on public.records from anon;
revoke all on public.pages   from anon;
revoke all on public.jobs    from anon;
