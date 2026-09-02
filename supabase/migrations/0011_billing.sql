-- Backs Section D of the production punch list (billing). Prepaid balance
-- top-ups via Stripe Checkout (monetization outline doc, Section 14.1),
-- margin target decided at 50% — see deduct_balance below for where that
-- number actually lands in code.

-- Lets create-checkout-session reuse one Stripe customer per user across
-- top-ups (and, later, for opt-in auto-reload's saved payment method)
-- instead of creating a fresh anonymous Stripe customer every time.
alter table profiles add column if not exists stripe_customer_id text;

-- SECURITY FIX, not just a new column: migration 0009's "Users can update
-- own profile" RLS policy only restricts *which row* a user can touch
-- (their own), never *which columns*. Supabase's default privileges grant
-- UPDATE on every column of a new table to `authenticated` unless
-- explicitly revoked, which meant any signed-in user could already run
-- `update profiles set balance_usd = 999999 where id = auth.uid()` — a
-- non-issue while balance_usd only ever held 0, but a real hole now that
-- it's about to hold real money. This revokes blanket UPDATE and grants
-- back only the columns a user should ever be able to write directly
-- (their own feature-toggle/node-count preferences, per Section C).
-- balance_usd, stripe_customer_id, email, and id are now only ever
-- changed by the deduct_balance/credit_balance functions below or the
-- signup trigger, both running as security definer / service role.
revoke update on profiles from authenticated;
grant update (auto_reload, feature_news, feature_today, feature_dig_deeper, node_count) on profiles to authenticated;

-- One row per successful top-up. Exists for two reasons: idempotency (the
-- unique constraint on stripe_session_id means a retried webhook delivery
-- can never credit the same payment twice) and a real transaction history
-- a user could eventually be shown on their account page.
create table if not exists billing_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_session_id text not null unique,
  stripe_payment_intent_id text,
  amount_usd numeric(10,2) not null,
  status text not null default 'completed',
  created_at timestamptz not null default now()
);

alter table billing_transactions enable row level security;

-- Read-only for the owning user — rows are only ever written by
-- stripe-webhook via the service role, which bypasses RLS entirely, so no
-- insert/update/delete policy is needed (or wanted) for any other role.
create policy "Users can read own billing transactions"
  on billing_transactions for select
  using (auth.uid() = user_id);

-- Both functions do the whole read-modify-write as a single atomic SQL
-- UPDATE (no separate select-then-write from application code), so
-- concurrent requests against the same balance can't race each other.
-- security definer + the explicit revoke/grant below means only the
-- service role (i.e. these two edge functions) can ever call them —
-- without the revoke, Supabase's default privileges would let any
-- signed-in user invoke deduct_balance/credit_balance on their own
-- account directly via PostgREST's RPC endpoint.

-- Real per-action Anthropic cost, marked up to hit the 50% margin target
-- decided for the $10 minimum (monetization outline doc, Section 14.1) —
-- rabbit-hole-proxy passes in real_cost / (1 - 0.5) = real_cost * 2, so a
-- $10 balance depletes after ~$5 of real API cost, matching 14.1's table.
-- Floored at 0 rather than going negative — the balance hitting exactly
-- $0 is what src/App.jsx's funded-check treats as "drop to Dig In only."
create or replace function deduct_balance(p_user_id uuid, p_amount numeric)
returns void
language sql
security definer
set search_path = public
as $$
  update profiles
  set balance_usd = greatest(balance_usd - p_amount, 0)
  where id = p_user_id;
$$;

-- Credits the FACE amount actually charged (Stripe's amount_total), never
-- a client-supplied number — the margin is applied on the spend side
-- (deduct_balance above), not by shaving anything off the credit itself.
-- A user who pays $10 sees a $10 balance; it just drains at a marked-up
-- rate as they use it.
create or replace function credit_balance(p_user_id uuid, p_amount numeric)
returns void
language sql
security definer
set search_path = public
as $$
  update profiles
  set balance_usd = balance_usd + p_amount
  where id = p_user_id;
$$;

revoke execute on function deduct_balance(uuid, numeric) from public, anon, authenticated;
revoke execute on function credit_balance(uuid, numeric) from public, anon, authenticated;
grant execute on function deduct_balance(uuid, numeric) to service_role;
grant execute on function credit_balance(uuid, numeric) to service_role;
