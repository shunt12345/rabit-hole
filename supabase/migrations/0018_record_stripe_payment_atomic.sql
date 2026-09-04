-- Fixes a real bug found in a code audit (and already hit once in
-- production — the "$10 payment recorded but never credited" incident
-- that needed a manual SQL patch): stripe-webhook used to insert into
-- billing_transactions and then call credit_balance as two separate
-- round trips. If the insert succeeded but credit_balance failed (a
-- transient hiccup), the function returned 500 and Stripe retried — but
-- the retry's insert then hit the unique constraint on stripe_session_id
-- and took the "duplicate" branch, permanently skipping the credit with
-- no error surfaced anywhere.
--
-- Combining both writes into one plpgsql function means they commit or
-- roll back together. If credit fails, the insert rolls back too, so a
-- retry cleanly redoes both from scratch — no way to end up with a
-- recorded transaction and an un-credited balance. A retry that arrives
-- after a truly successful prior run hits the same unique constraint,
-- caught here as a no-op duplicate exactly like before.
create or replace function record_stripe_payment(
  p_user_id uuid,
  p_stripe_session_id text,
  p_stripe_payment_intent_id text,
  p_amount_usd numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into billing_transactions (user_id, stripe_session_id, stripe_payment_intent_id, amount_usd, status)
  values (p_user_id, p_stripe_session_id, p_stripe_payment_intent_id, p_amount_usd, 'completed');

  update profiles
  set balance_usd = balance_usd + p_amount_usd
  where id = p_user_id;
exception
  when unique_violation then
    -- Both the insert and the credit above happen in this one
    -- transaction, so landing here means a prior call already committed
    -- both together — a genuine duplicate delivery, not a partial state.
    null;
end;
$$;

revoke execute on function record_stripe_payment(uuid, text, text, numeric) from public, anon, authenticated;
grant execute on function record_stripe_payment(uuid, text, text, numeric) to service_role;
