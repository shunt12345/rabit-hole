-- The Riddle as a guessing game (src/RiddleGame.jsx): "What am I?" with
-- four clue threads, three hints and a free-text guess.
--
-- riddle_game holds what the game needs beyond the existing riddle row
-- (topic = the answer, teaser = the one-sentence riddle the digest uses):
--   { "clues":   [{ "title", "field", "teaser" }, ...4, hardest first],
--     "hints":   ["vaguest", "...", "most direct"],
--     "answers": ["accepted", "spellings"] }
-- Written by generate-trending-topics, curated on /queue. Riddle rows
-- without it keep the old multiple-choice card.
alter table trending_topics_cache
  add column if not exists riddle_game jsonb;

-- One row per signed-in player per riddle: the result the hero card shows
-- after playing, and what the streak counts.
create table if not exists riddle_results (
  user_id uuid not null references auth.users (id) on delete cascade,
  riddle_id bigint not null,
  play_date date not null,
  solved boolean not null,
  guesses int not null,
  hints int not null,
  created_at timestamptz not null default now(),
  primary key (user_id, riddle_id)
);

alter table riddle_results enable row level security;

create policy "Players read their own riddle results"
  on riddle_results for select
  using (auth.uid() = user_id);

create policy "Players record their own riddle results"
  on riddle_results for insert
  with check (auth.uid() = user_id);
