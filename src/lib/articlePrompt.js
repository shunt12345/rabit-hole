// The per-request half of a "read more" article prompt (the fixed half is
// HYFAX_SYSTEM). Shared by App.jsx and the admin Tone Lab, so a model
// comparison runs on exactly the prompt real readers get.
import { nextOpenerShape } from "./openerVariety.js";

// Room for a What / Why / Why page (~340-480 words plus its labels): the
// model overshoots a word count it's only asked to keep. App.jsx trims a capped article back to its last
// complete sentence.
export const ARTICLE_MAX_TOKENS = 1100;

export function articleUserPrompt({ topicLabel, path, newsContext, nodeType, heroSource }) {
  const today = new Date().toISOString().slice(0, 10);
  const titleNote = nodeType === "root" ? "\n\nBegin with a title line." : "";
  // How to treat the date depends on which daily pick this is: a history
  // pick happened on this date years ago (say so, with the year — never
  // "recently"); a Trending pick is current news (write it as recent, and
  // spend the article on why it matters); a quote's context is its
  // attribution. Seen live: one shared rule produced "Recently, on
  // October 19, 1960".
  const isHistory = heroSource === "This Day In History";
  const isTrending = /^Trending\b/.test(heroSource || "");
  const isQuote = heroSource === "Quote Of The Day";
  const dateNote = isHistory
    ? ` This is today's "This Day in History" pick: it happened on this calendar date in a past year. Say the date and year plainly (e.g. "On October 19, 1960") and write it as history. Never call it recent, new or "this week".`
    : isTrending
      ? ` This is current news. Don't spell out the exact calendar date it happened (e.g. "On August 8, 2025"); write it as recent instead ("recently," "this week") — a hardcoded date reads as stale the moment it's read after the fact. Assume the reader has already seen the headline: the WHAT states what happened in plain facts, and the WHY sections carry why it happened and why it matters. Every detail about this story itself (what happened, when, who did what, any amount, figure, count or date) must come from the context above. Never add one it doesn't give, and never say a step has already happened (a launch, a vote, a sale, a listing) unless the context says so; if something isn't known yet, say that or leave it out. Long-established background from your own knowledge (who founded a company, how a process works) is fine, but nothing about the latest news that isn't in the context.`
      : isQuote
        ? ` The context above is the quote's attribution; use it accurately as given.`
        : ` Don't spell out an exact calendar date unless the date itself is the point of the story.`;
  const newsNote = newsContext
    ? `\n\nThis topic comes with specific context worth reflecting accurately, picked from one of the hero page's live feeds: "${newsContext}".${dateNote}`
    : "";
  // Today's date is real grounding, not decoration — without it, "current"
  // in the model's own training data can be a year or more stale by the
  // time this actually runs (confirmed live: an ordinary, non-news topic
  // wrote "Apple is expected to unveil its first foldable iPhone" framed
  // as upcoming, dated September 2025 — a full year in the past by the
  // time a reader actually saw it).
  // Assigns the second paragraph's opener a specific shape rather than
  // leaving "vary it" to the model — see openerVariety.js for why a
  // stateless per-call instruction alone wasn't producing real variety
  // across separate articles for one active user.
  const openerNote = `\n\nFor the WHY IT HAPPENS paragraph's opening sentence specifically, use this exact approach: ${nextOpenerShape()}.`;
  return `TASK: read-more article

Today's date is ${today}.

Path so far: ${path.join(" → ")}
Topic: "${topicLabel}"${newsNote}${titleNote}${openerNote}`;
}
