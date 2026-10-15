-- Email-only sign-up for the daily digest: anyone can get the email without
-- making an account. Double opt-in — a row starts 'pending' and only gets
-- the digest once its owner clicks the confirm link (see
-- supabase/functions/digest-subscribe), so nobody can sign up someone
-- else's address and the list stays clean for deliverability.
--
-- Service role only (RLS on, no policies), same as visitors/events: the
-- browser never reads or writes this table directly.
create table if not exists digest_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'unsubscribed')),
  confirm_token uuid not null default gen_random_uuid(),
  -- Where the sign-up came from ('home', 'article'), and the visit's
  -- utm_source, for /admin.
  source text,
  utm_source text,
  ip_address text,
  created_at timestamptz not null default now(),
  confirm_sent_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz
);

-- One row per address, whatever its capitalisation.
create unique index if not exists digest_subscribers_email_idx on digest_subscribers (lower(email));
create index if not exists digest_subscribers_status_idx on digest_subscribers (status);
create index if not exists digest_subscribers_ip_created_idx on digest_subscribers (ip_address, created_at);

alter table digest_subscribers enable row level security;
