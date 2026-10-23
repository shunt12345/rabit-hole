import { useEffect, useRef, useState } from "react";
import { HelpCircle, Lightbulb, Share2, ArrowRight, Check, Eye } from "lucide-react";
import { supabase } from "./lib/supabaseClient.js";
import { isCorrectGuess, clueLine, answerBlocks, hintLetterPositions } from "./lib/riddle.js";

// The Riddle as a guessing game: "What am I?" — the answer's letters as
// blank blocks, the first (hardest) clue shown and the other three revealed
// one at a time, up to three hints (each fills in a letter: the last, the
// middle, then the first), three guesses. Anyone can play, no account
// needed. Solving goes straight to the answer's page, which opens with
// these same clues as its threads.
//
// Results are kept in this browser (HISTORY_KEY), which is the streak for
// someone signed out; the result screen offers a free account to keep it
// on any device. Signed in, results are saved to riddle_results (migration
// 0056), and any played signed out in this browser are copied there too.
//
// Progress for the day's riddle lives in localStorage, so a refresh or a
// trip to the answer page doesn't reset it.
//
// A preview (riddle.preview, from /queue's "Preview & play") plays the same
// way but records nothing, keeps its progress apart from the live riddle's,
// and can be reset to play again.

const MAX_GUESSES = 3;
// The share button is hidden for now; the share text (threadScore's emoji
// grid) is kept for when it comes back.
const SHOW_SHARE = false;
const C = {
  card: "#241B12",
  border: "#4A3826",
  text: "#F1E6D3",
  dim: "#A89478",
  label: "#C9B896",
  accent: "#E3A73C",
  bad: "#D98A6E",
  bg: "#14100C",
};

// Every riddle result in this browser, newest first: the streak without an
// account, and what's copied to riddle_results on signing in.
const HISTORY_KEY = "hyfax-riddle-history";
const HISTORY_MAX = 120;
function loadHistory() {
  try {
    const rows = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
function addToHistory(row) {
  try {
    const rows = [row, ...loadHistory().filter((r) => r.riddle_id !== row.riddle_id)].slice(0, HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(rows));
  } catch {
    // Storage unavailable: no streak without an account.
  }
}

function storageKey(id) {
  return `hyfax-riddle-${id}`;
}
// clues: how many clues are showing (the first is always shown).
function emptyProgress() {
  return { clues: 1, hints: 0, wrong: [], outcome: null };
}
function loadProgress(id) {
  try {
    return { ...emptyProgress(), ...JSON.parse(localStorage.getItem(storageKey(id)) || "{}") };
  } catch {
    return emptyProgress();
  }
}
function saveProgress(id, p) {
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(p));
  } catch {
    // Storage unavailable — progress just won't survive a refresh.
  }
}

function playDate(riddle) {
  return new Date(riddle.publish_at || riddle.generated_at).toISOString().slice(0, 10);
}

// Consecutive days solved, counting back from the latest solved day if it
// is this riddle's day or the one before (so the streak still shows until
// today's riddle is played).
function streakFrom(results, today) {
  const solvedDays = new Set(results.filter((r) => r.solved).map((r) => r.play_date));
  const day = new Date(`${today}T00:00:00Z`);
  if (!solvedDays.has(today)) day.setUTCDate(day.getUTCDate() - 1);
  let streak = 0;
  while (solvedDays.has(day.toISOString().slice(0, 10))) {
    streak++;
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return streak;
}

// 🧵 for each hint left unused, ⬜ for each one taken.
function threadScore(hints) {
  return "🧵".repeat(3 - hints) + "⬜".repeat(hints);
}

export default function RiddleGame({ riddle, user, onSignUp, onOpenAnswer, disabled, className = "" }) {
  const game = riddle.riddle_game;
  const key = riddle.preview ? `preview-${riddle.id}` : riddle.id;
  const [progress, setProgress] = useState(() => loadProgress(key));
  const [guess, setGuess] = useState("");
  const [shake, setShake] = useState(false);
  const [streak, setStreak] = useState(0);
  const [shared, setShared] = useState(false);
  const openTimer = useRef(null);
  // The letter boxes shrink so the longest word fits on one line of the
  // card (28px wide at most, 4px apart), however narrow the screen.
  const lettersRef = useRef(null);
  const [lettersWidth, setLettersWidth] = useState(0);
  useEffect(() => {
    const el = lettersRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setLettersWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const today = playDate(riddle);

  useEffect(() => {
    setProgress(loadProgress(key));
    setGuess("");
  }, [key]);
  useEffect(() => () => clearTimeout(openTimer.current), []);

  // The daily email's "Make your guess" link (?play=riddle) lands here.
  const cardRef = useRef(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("play") !== "riddle") return;
    const t = setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
    return () => clearTimeout(t);
  }, []);

  const update = (next) => {
    setProgress(next);
    saveProgress(key, next);
  };

  // The streak, and this riddle's result if it was played elsewhere (signed
  // in, another device). Signing in copies this browser's results into the
  // account first, so a streak built signed out carries over.
  const loadResults = async () => {
    if (riddle.preview) return;
    const local = loadHistory();
    if (!user) {
      setStreak(streakFrom(local, today));
      return;
    }
    const { data } = await supabase
      .from("riddle_results")
      .select("riddle_id, play_date, solved, guesses, hints")
      .eq("user_id", user.id)
      .order("play_date", { ascending: false })
      .limit(HISTORY_MAX);
    let rows = data || [];
    const saved = new Set(rows.map((r) => r.riddle_id));
    const unsaved = local.filter((r) => !saved.has(r.riddle_id));
    if (unsaved.length) {
      const { error } = await supabase.from("riddle_results").insert(unsaved.map((r) => ({ ...r, user_id: user.id })));
      if (!error) rows = [...rows, ...unsaved];
    }
    setStreak(streakFrom(rows, today));
    const mine = rows.find((r) => r.riddle_id === riddle.id);
    if (mine && !progress.outcome) {
      update({ ...progress, outcome: mine.solved ? "solved" : "stumped", hints: mine.hints, guesses: mine.guesses });
    }
  };
  useEffect(() => {
    loadResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, riddle.id]);

  const record = async (solved, guesses, hints) => {
    if (riddle.preview) return;
    addToHistory({ riddle_id: riddle.id, play_date: today, solved, guesses, hints });
    if (user) {
      await supabase
        .from("riddle_results")
        .insert({ user_id: user.id, riddle_id: riddle.id, play_date: today, solved, guesses, hints });
    }
    loadResults();
  };

  const submit = (raw) => {
    const text = (raw ?? guess).trim();
    if (!text || progress.outcome) return;
    if (isCorrectGuess(text, riddle.topic, game.answers)) {
      const next = { ...progress, outcome: "solved", guesses: progress.wrong.length + 1 };
      update(next);
      record(true, next.guesses, progress.hints);
      openTimer.current = setTimeout(onOpenAnswer, 1600);
      return;
    }
    const wrong = [...progress.wrong, text];
    const out = wrong.length >= MAX_GUESSES;
    update({ ...progress, wrong, ...(out ? { outcome: "stumped", guesses: wrong.length } : {}) });
    if (out) record(false, wrong.length, progress.hints);
    setGuess("");
    setShake(true);
    setTimeout(() => setShake(false), 450);
  };

  const share = async () => {
    const date = new Date(`${today}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const line =
      progress.outcome === "solved"
        ? `${threadScore(progress.hints)} solved in ${progress.guesses} guess${progress.guesses === 1 ? "" : "es"}`
        : "⬛⬛⬛ stumped";
    const text = `Hyfax Riddle · ${date}\n${line}\nhttps://hyfax.app`;
    try {
      if (navigator.share) await navigator.share({ text });
      else await navigator.clipboard.writeText(text);
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    } catch {
      // Share sheet dismissed — nothing to do.
    }
  };

  const guessesLeft = MAX_GUESSES - progress.wrong.length;
  const done = !!progress.outcome;
  const cluesShown = Math.min(game.clues.length, Math.max(1, progress.clues || 1));
  const letterCount = answerBlocks(riddle.topic).flat().filter((b) => b.blank).length;
  // Each hint fills in one letter: the last, then the middle, then the first.
  const hintSpots = hintLetterPositions(riddle.topic);
  const maxHints = hintSpots.length;
  const shownLetters = new Set(hintSpots.slice(0, progress.hints));
  const longestWord = Math.max(1, ...answerBlocks(riddle.topic).map((word) => word.length));
  const box = lettersWidth ? Math.max(14, Math.min(28, Math.floor((lettersWidth - (longestWord - 1) * 4) / longestWord))) : 28;
  let letterIndex = -1;

  return (
    <div className={`mt-10 ${className}`} id="riddle" ref={cardRef}>
      {/* Beside the Hyfax of the Day on a wide screen, where "What am I?"
          is title enough. */}
      <div className="flex items-center justify-center gap-1.5 mb-6 lg:hidden">
        <HelpCircle size={14} style={{ color: C.label }} />
        <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: C.label }}>
          Riddle me this....
        </span>
      </div>
      {riddle.preview && (
        <div className="max-w-md lg:max-w-none mx-auto mb-2 flex items-center justify-between rounded-xl border px-3 py-2 rh-body text-xs" style={{ borderColor: C.accent, color: C.accent }}>
          <span>Preview — not live. Nothing you do here is saved.</span>
          <button type="button" onClick={() => update(emptyProgress())} className="underline">
            Reset
          </button>
        </div>
      )}
      <div className="max-w-md lg:max-w-none mx-auto text-left p-5 rounded-2xl border" style={{ borderColor: C.border, backgroundColor: C.card }}>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="rh-display italic text-2xl" style={{ color: C.text }}>
            What am I?
          </h3>
          {streak > 0 && (
            <span className="rh-mono text-xs" style={{ color: C.accent }}>
              🔥 {streak}-day streak
            </span>
          )}
        </div>

        {/* The answer's letters as blocks — how many letters, and words —
            with any letters the hints gave, all filled in once the riddle
            is over. */}
        <div ref={lettersRef} className="flex flex-wrap gap-x-4 gap-y-2 mb-4" aria-label={done ? riddle.topic : `${letterCount} letters`}>
          {answerBlocks(riddle.topic).map((word, w) => (
            <div key={w} className="flex gap-1">
              {word.map((b, i) => {
                if (!b.blank) {
                  return (
                    <span key={i} className="flex items-end rh-mono text-base" style={{ color: C.dim, height: `${Math.round(box * 1.15)}px` }}>
                      {b.ch}
                    </span>
                  );
                }
                letterIndex++;
                const hinted = !done && shownLetters.has(letterIndex);
                return (
                  <span
                    key={i}
                    className={`flex items-center justify-center rounded-md rh-mono font-semibold uppercase ${done || hinted ? "rh-fade-in" : ""}`}
                    style={{
                      width: `${box}px`,
                      height: `${Math.round(box * 1.15)}px`,
                      fontSize: `${Math.max(11, Math.round(box * 0.57))}px`,
                      // Bright enough to read as empty squares on the dark card.
                      border: `1.5px solid ${done || hinted ? C.accent : C.label}`,
                      backgroundColor: done ? C.bg : "#2E2318",
                      color: progress.outcome === "solved" || hinted ? C.accent : C.text,
                      animationDelay: done ? `${(w * 6 + i) * 60}ms` : "0ms",
                    }}
                  >
                    {done || hinted ? b.ch : ""}
                  </span>
                );
              })}
            </div>
          ))}
        </div>

        {/* The first (hardest) clue is shown; the rest are revealed one at
            a time. All of them show once the riddle is over. */}
        <ol className="flex flex-col gap-2 mb-3">
          {game.clues.slice(0, done ? game.clues.length : cluesShown).map((c, i) => (
            <li key={i} className="rh-body text-sm rh-fade-in" style={{ color: "#B8A886" }}>
              {/* Same font and color as the hero cards' teasers; the number is
                  inline so wrapped lines line up with the card's other text. */}
              {i + 1}.{" "}
              {clueLine(c, riddle.topic, game.answers)}
            </li>
          ))}
        </ol>
        {!done && cluesShown < game.clues.length && (
          <button
            type="button"
            onClick={() => update({ ...progress, clues: cluesShown + 1 })}
            disabled={disabled}
            className="flex items-center gap-1 rounded-full border px-3 py-1.5 rh-body text-xs mb-4 disabled:opacity-40"
            style={{ borderColor: C.accent, color: C.accent }}
          >
            <Eye size={13} /> Reveal clue {cluesShown + 1}
          </button>
        )}

        {!done ? (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
              className={`flex items-center gap-2 ${shake ? "rh-riddle-shake" : ""}`}
            >
              <input
                type="text"
                value={guess}
                onChange={(e) => setGuess(e.target.value)}
                placeholder="Your guess…"
                disabled={disabled}
                className="flex-1 min-w-0 rounded-full border px-4 py-2 rh-body text-sm outline-none"
                style={{ backgroundColor: C.bg, borderColor: C.border, color: C.text }}
                aria-label="Your guess"
              />
              <button
                type="button"
                onClick={() => update({ ...progress, hints: Math.min(maxHints, progress.hints + 1) })}
                disabled={disabled || progress.hints >= maxHints}
                className="flex items-center gap-1 rounded-full border px-3 py-2 rh-body text-xs shrink-0 disabled:opacity-40"
                style={{ borderColor: C.accent, color: C.accent }}
              >
                <Lightbulb size={13} /> Hint
              </button>
              <button
                type="submit"
                disabled={disabled || !guess.trim()}
                className="rounded-full px-4 py-2 rh-body text-xs font-semibold shrink-0 disabled:opacity-40"
                style={{ backgroundColor: C.accent, color: C.bg }}
              >
                Submit
              </button>
            </form>
            <div className="flex items-center justify-between mt-3 rh-body text-xs" style={{ color: C.dim }}>
              <span>
                {guessesLeft} guess{guessesLeft === 1 ? "" : "es"} left
                {progress.wrong.length > 0 && (
                  <span style={{ color: C.bad }}> · not {progress.wrong.map((w) => `“${w}”`).join(", ")}</span>
                )}
              </span>
            </div>
          </>
        ) : (
          <div className="rh-fade-in">
            <div className="rh-body text-base font-semibold" style={{ color: progress.outcome === "solved" ? C.accent : C.bad }}>
              {progress.outcome === "solved" ? (
                <span className="flex items-center gap-1.5">
                  <Check size={16} /> {riddle.topic}, solved in {progress.guesses} guess{progress.guesses === 1 ? "" : "es"} with {cluesShown} of{" "}
                  {game.clues.length} clues and {progress.hints === 0 ? "no hints" : `${progress.hints} hint${progress.hints === 1 ? "" : "s"}`}
                </span>
              ) : (
                <>Stumped — it was {riddle.topic}.</>
              )}
            </div>
            <div className="flex items-center gap-2 mt-4">
              <button
                type="button"
                onClick={onOpenAnswer}
                data-precompute="hero"
                disabled={disabled}
                className="flex items-center gap-1 rounded-full px-4 py-2 rh-body text-xs font-semibold disabled:opacity-40"
                style={{ backgroundColor: C.accent, color: C.bg }}
              >
                Read about it <ArrowRight size={13} />
              </button>
              {SHOW_SHARE && (
                <button
                  type="button"
                  onClick={share}
                  className="flex items-center gap-1 rounded-full border px-3 py-2 rh-body text-xs"
                  style={{ borderColor: C.accent, color: C.accent }}
                >
                  <Share2 size={13} /> {shared ? "Copied!" : "Share result"}
                </button>
              )}
            </div>
            {/* Played signed out: the streak lives in this browser until
                they sign up. */}
            {!user && !riddle.preview && (
              <button
                type="button"
                onClick={onSignUp}
                className="mt-4 w-full text-left rounded-xl border px-3 py-2.5 rh-body text-xs leading-snug"
                style={{ borderColor: C.border, color: C.label }}
              >
                {streak > 0 ? `Keep your 🔥 ${streak}-day streak on any device.` : "Start a streak that follows you to any device."}{" "}
                <span className="font-semibold" style={{ color: C.accent }}>
                  Sign up free →
                </span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
