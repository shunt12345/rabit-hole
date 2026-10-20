-- The "cards" vs "scroll" test (see src/lib/variant.js): each visitor's
-- group, set once by track-event and never changed, and a new event type
-- for a thread followed by scrolling into it rather than tapping its card.
-- Test visitors are never given a group.
alter table visitors add column if not exists variant text check (variant in ('cards', 'scroll'));
create index if not exists visitors_variant_idx on visitors (variant);

alter table events drop constraint if exists events_type_check;
alter table events add constraint events_type_check
  check (type in ('land', 'tap', 'article_view', 'signup', 'scroll_continue'));
