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

// A clue as the player reads it in the game: its riddle line, or — for a
// riddle written before clues had one — its after-the-fact description
// with the answer blanked out.
export function clueLine(clue, topic, answers = []) {
  if (clue?.line?.trim()) return clue.line.trim();
  let text = String(clue?.teaser || clue?.title || "");
  const phrases = [topic, ...answers]
    .map((a) => String(a || "").trim())
    .filter((a) => a.length >= 3)
    .sort((x, y) => y.length - x.length);
  for (const phrase of phrases) {
    const pattern = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    // Word forms too ("salty", "salted"), so the blank doesn't leak.
    text = text.replace(new RegExp(`\\b${pattern}(e?s|y|ed|ing)?\\b`, "gi"), "___");
  }
  return text;
}

// The answer as letter blocks: one per letter or digit, a gap between
// words, and any other character (an apostrophe, a hyphen) shown as is. A
// leading "The"/"A"/"An" isn't part of it ("The Dead Sea" is two words to
// find), the same way a guess doesn't need it (see isCorrectGuess).
export function answerBlocks(topic) {
  return String(topic || "")
    .trim()
    .replace(/^(the|a|an)\s+(?=\S)/i, "")
    .split(/\s+/)
    .map((word) => [...word].map((ch) => ({ ch, blank: /[\p{L}\p{N}]/u.test(ch) })));
}

// Which letters the three hints fill in, as positions among the answer's
// letters (blocks left to right, spaces and punctuation skipped): the
// last letter, then the middle one, then the first.
export function hintLetterPositions(topic) {
  const n = answerBlocks(topic).flat().filter((b) => b.blank).length;
  if (!n) return [];
  return [...new Set([n - 1, Math.floor(n / 2), 0])];
}

// What /queue flags before a riddle can be approved without an override:
// clues sharing a field, a clue line or hint that gives the answer away, a
// clue line that repeats a hint, or missing pieces — including a clue with
// no line for players. Returns plain-language problems;
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
    // Players only see a clue's line before solving (its thread title shows
    // on the answer page after), so the giveaway checks look at the line.
    if (!normalize(c.line)) issues.push(`clue ${i + 1} has no line for players`);
    else if (givesAway(c.line)) issues.push(`clue ${i + 1}'s line names the answer`);
    const hintWord = hints.flatMap(words).find((w) => words(c.line || "").includes(w));
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
