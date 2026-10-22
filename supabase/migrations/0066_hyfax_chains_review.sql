-- New Hyfax threads wait for review: generate-hyfax-chains writes them as
-- 'pending', and /queue approves or rejects each one. Spin a thread only
-- offers approved threads (the read policy from 0065 is unchanged).
alter table hyfax_chains drop constraint if exists hyfax_chains_status_check;
alter table hyfax_chains add constraint hyfax_chains_status_check check (status in ('pending', 'approved', 'rejected'));
create index if not exists hyfax_chains_status_idx on hyfax_chains (status, created_at desc);
