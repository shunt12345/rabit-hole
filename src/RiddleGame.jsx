import { useEffect, useRef, useState } from "react";
import { HelpCircle, Lightbulb, Share2, ArrowRight, Check } from "lucide-react";
import { supabase } from "./lib/supabaseClient.js";
import { isCorrectGuess } from "./lib/riddle.js";

// The Riddle as a guessing game: "What am I?", four clue threads (hardest
// first), up to three hints, three guesses. Anyone can read the clues and
// take hints; submitting a guess needs a free account — a signed-out
// guess is held, sign-up opens, and it goes in once they're signed in
// (even in the tab the magic link opens). Solving goes straight to the
// answer's page, which opens with these same clues as its threads.
// Signed-in results are saved to
// riddle_results (migration 0056), which the streak counts.
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

function storageKey(id) {
  return `hyfax-riddle-${id}`;
}
function emptyProgress() {
  return { hints: 0, wrong: [], outcome: null, pending: null };
}
function loadProgress(id) {
  try {
    return { hints: 0, wrong: [], outcome: null, pending: null, ...JSON.parse(localStorage.getItem(storageKey(id)) || "{}") };
  } catch {
    return { hints: 0, wrong: [], outcome: null, pending: null };
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

export default function RiddleGame({ riddle, user, onSignUp, onOpenAnswer, disabled }) {
  const game = riddle.riddle_game;
  const key = riddle.preview ? `preview-${riddle.id}` : riddle.id;
  const [progress, setProgress] = useState(() => loadProgress(key));
  const [guess, setGuess] = useState("");
  const [shake, setShake] = useState(false);
  const [streak, setStreak] = useState(0);
  const [shared, setShared] = useState(false);
  const openTimer = useRef(null);
  const today = playDate(riddle);

  useEffect(() => {
    setProgress(loadProgress(key));
    setGuess("");
  }, [key]);
  useEffect(() => () => clearTimeout(openTimer.current), []);

  const update = (next) => {
    setProgress(next);
    saveProgress(key, next);
  };

  // Signed in: this riddle's saved result (another device, say) and the
  // streak.
  const loadResults = async () => {
    if (!user || riddle.preview) return;
    const { data } = await supabase
      .from("riddle_results")
      .select("riddle_id, play_date, solved, guesses, hints")
      .eq("user_id", user.id)
      .order("play_date", { ascending: false })
      .limit(120);
    const rows = data || [];
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
    if (!user || riddle.preview) return;
    await supabase
      .from("riddle_results")
      .insert({ user_id: user.id, riddle_id: riddle.id, play_date: today, solved, guesses, hints });
    loadResults();
  };

  const submit = (raw) => {
    const text = (raw ?? guess).trim();
    if (!text || progress.outcome) return;
    if (!user) {
      update({ ...progress, pending: text });
      onSignUp();
      return;
    }
    if (isCorrectGuess(text, riddle.topic, game.answers)) {
      const next = { ...progress, pending: null, outcome: "solved", guesses: progress.wrong.length + 1 };
      update(next);
      record(true, next.guesses, progress.hints);
      openTimer.current = setTimeout(onOpenAnswer, 1600);
      return;
    }
    const wrong = [...progress.wrong, text];
    const out = wrong.length >= MAX_GUESSES;
    update({ ...progress, pending: null, wrong, ...(out ? { outcome: "stumped", guesses: wrong.length } : {}) });
    if (out) record(false, wrong.length, progress.hints);
    setGuess("");
    setShake(true);
    setTimeout(() => setShake(false), 450);
  };

  // A guess typed before signing up goes in once they're signed in.
  useEffect(() => {
    if (user && progress.pending && !progress.outcome) submit(progress.pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

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

  return (
    <div className="mt-10">
      <div className="flex items-center justify-center gap-1.5 mb-6">
        <HelpCircle size={14} style={{ color: C.label }} />
        <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: C.label }}>
          Riddle me this....
        </span>
      </div>
      {riddle.preview && (
        <div className="max-w-md mx-auto mb-2 flex items-center justify-between rounded-xl border px-3 py-2 rh-body text-xs" style={{ borderColor: C.accent, color: C.accent }}>
          <span>Preview — not live. Nothing you do here is saved.</span>
          <button type="button" onClick={() => update(emptyProgress())} className="underline">
            Reset
          </button>
        </div>
      )}
      <div className="max-w-md mx-auto text-left p-5 rounded-2xl border" style={{ borderColor: C.border, backgroundColor: C.card }}>
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

        <ol className="flex flex-col gap-1.5 mb-4">
          {game.clues.map((c, i) => (
            <li key={i} className="flex items-baseline gap-2 rh-body text-base" style={{ color: C.text }}>
              <span className="rh-mono text-xs w-4 shrink-0" style={{ color: C.dim }}>
                {i + 1}
              </span>
              {c.title}
            </li>
          ))}
        </ol>

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
                onClick={() => update({ ...progress, hints: Math.min(3, progress.hints + 1) })}
                disabled={disabled || progress.hints >= 3}
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
            {progress.hints > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {game.hints.slice(0, progress.hints).map((h, i) => (
                  <span key={i} className="rounded-full px-2.5 py-1 rh-body text-xs" style={{ backgroundColor: "#3A2A16", color: C.accent }}>
                    {h}
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between mt-3 rh-body text-xs" style={{ color: C.dim }}>
              <span>
                {guessesLeft} guess{guessesLeft === 1 ? "" : "es"} left
                {progress.wrong.length > 0 && (
                  <span style={{ color: C.bad }}> · not {progress.wrong.map((w) => `“${w}”`).join(", ")}</span>
                )}
              </span>
              {!user && <span>Free account to submit</span>}
            </div>
            {!user && progress.pending && (
              <p className="mt-2 rh-body text-xs" style={{ color: C.accent }}>
                Sign up free and your guess “{progress.pending}” goes straight in.
              </p>
            )}
          </>
        ) : (
          <div className="rh-fade-in">
            <div className="rh-body text-base font-semibold" style={{ color: progress.outcome === "solved" ? C.accent : C.bad }}>
              {progress.outcome === "solved" ? (
                <span className="flex items-center gap-1.5">
                  <Check size={16} /> {riddle.topic}, solved in {progress.guesses} guess{progress.guesses === 1 ? "" : "es"} with{" "}
                  {progress.hints === 0 ? "no hints" : `${progress.hints} hint${progress.hints === 1 ? "" : "s"}`}
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
          </div>
        )}
      </div>
    </div>
  );
}
