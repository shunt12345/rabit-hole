-- Launch promo: anyone who signs up before the cutoff below starts with a
-- $10 balance instead of the normal $0 default (migration 0009), so
-- people getting the app for the first time land straight in the funded
-- experience instead of hitting the free tier first. Time-limited by
-- design, not a permanent feature — a real cost commitment at the 50%
-- margin markup (~$5 of actual Anthropic spend per credited signup), so
-- this is a deliberate launch window, not something meant to run forever
-- or be reopened casually. Ending it later just means nobody edits this
-- cutoff again; there's no separate "is the promo on" toggle to remember
-- to flip off.
--
-- promo_credits exists so this never gets confused with real revenue —
-- billing_transactions (migration 0011) is Stripe-sourced money only, so
-- a query summing it for "total revenue" stays accurate even with this
-- running. balance_usd itself doesn't distinguish the two once credited
-- (a promo dollar spends exactly like a paid one), which is intentional;
-- this table is purely for looking back at how much was given away vs.
-- actually paid.
create table if not exists promo_credits (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade unique,
  amount_usd numeric(10,2) not null,
  reason text not null default 'launch_signup_bonus',
  created_at timestamptz not null default now()
);

alter table promo_credits enable row level security;

create policy "Users can read own promo credits"
  on promo_credits for select
  using (auth.uid() = user_id);

-- Replaces migration 0009's handle_new_user — same trigger (on_auth_user_created)
-- stays bound to this function by name, so no trigger changes needed.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_promo_cutoff timestamptz := '2026-10-07 00:00:00+00'; -- through end of Oct 6, 2026 UTC
  v_balance numeric(10,2) := 0;
begin
  if now() < v_promo_cutoff then
    v_balance := 10.00;
  end if;

  insert into public.profiles (id, email, balance_usd)
  values (new.id, new.email, v_balance);

  if v_balance > 0 then
    insert into public.promo_credits (user_id, amount_usd, reason)
    values (new.id, v_balance, 'launch_signup_bonus');
  end if;

  return new;
end;
$$;
