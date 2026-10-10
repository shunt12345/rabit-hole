// The Riddle guessing game's shared rules — answer matching for the hero
// card (RiddleGame.jsx) and the balance check /queue curates against
// (ReviewQueue.jsx). generate-trending-topics' RIDDLE_CLUE_RULES asks for
// the same things this checks, so the two should change together.

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "in", "on", "to", "for", "us"]);

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripArticle(s) {
  return s.replace(/^(the|a|an) /, "");
}

// "pennies" → "penny", "glaciers" → "glacier" — so a plural guess counts.
function singular(s) {
  return s
    .split(" ")
    .map((w) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ");
}

function words(s) {
  return normalize(s)
    .split(" ")
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// A guess counts if it matches the answer or any accepted spelling,
// ignoring case, punctuation and a leading article, and forgiving a typo
// in a longer word (one slip from 5 letters, two from 9).
export function isCorrectGuess(guess, topic, answers = []) {
  const g = singular(stripArticle(normalize(guess)));
  if (!g) return false;
  return [topic, ...answers].some((a) => {
    const t = singular(stripArticle(normalize(a)));
    if (!t) return false;
    if (g === t) return true;
    const slack = t.length >= 9 ? 2 : t.length >= 5 ? 1 : 0;
    return slack > 0 && editDistance(g, t) <= slack;
  });
}

// What /queue flags before a riddle can be approved without an override:
// clues sharing a field, a clue or hint that gives the answer away, a clue
// that repeats a hint, or missing pieces. Returns plain-language problems;
// an empty list means balanced.
export function riddleBalanceIssues(topic, game) {
  const issues = [];
  const clues = game?.clues || [];
  const hints = game?.hints || [];
  if (clues.length !== 4) issues.push("needs exactly 4 clues");
  if (hints.length !== 3 || hints.some((h) => !normalize(h))) issues.push("needs 3 hints");
  if (!(game?.answers || []).length) issues.push("needs at least one accepted answer");

  const answerWords = new Set([topic, ...(game?.answers || [])].flatMap(words));
  const answerPhrases = [topic, ...(game?.answers || [])].map(normalize).filter((a) => a.length >= 3);
  const givesAway = (text) => {
    const n = ` ${normalize(text)} `;
    return words(text).some((w) => answerWords.has(w)) || answerPhrases.some((a) => n.includes(` ${a} `));
  };

  const byField = {};
  clues.forEach((c, i) => {
    if (!normalize(c.title)) issues.push(`clue ${i + 1} is empty`);
    if (!normalize(c.field)) issues.push(`clue ${i + 1} has no field`);
    else (byField[normalize(c.field)] ||= []).push(i + 1);
    if (givesAway(c.title)) issues.push(`clue ${i + 1} names the answer`);
    const hintWord = hints.flatMap(words).find((w) => words(c.title).includes(w));
    if (hintWord) issues.push(`clue ${i + 1} repeats the hint "${hintWord}"`);
  });
  Object.entries(byField).forEach(([field, nums]) => {
    if (nums.length > 1) issues.push(`${nums.length} clues in ${field} (${nums.join(", ")})`);
  });
  hints.forEach((h, i) => {
    if (givesAway(h)) issues.push(`hint ${i + 1} names the answer`);
  });
  return issues;
}
