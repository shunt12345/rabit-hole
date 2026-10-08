// The per-request half of a "read more" article prompt (the fixed half is
// HYFAX_SYSTEM). Shared by App.jsx and the admin Tone Lab, so a model
// comparison runs on exactly the prompt real readers get.
import { nextOpenerShape } from "./openerVariety.js";

// Holds article length (~150-190 words): the model overshoots a word count
// it's only asked to keep. App.jsx trims a capped article back to its last
// complete sentence.
export const ARTICLE_MAX_TOKENS = 400;

export function articleUserPrompt({ topicLabel, path, newsContext, nodeType }) {
  const today = new Date().toISOString().slice(0, 10);
  const titleNote = nodeType === "root" ? "\n\nBegin with a title line." : "";
  const newsNote = newsContext
    ? `\n\nThis topic comes with specific context worth reflecting accurately, picked from one of the hero page's live feeds: "${newsContext}". Don't spell out the exact calendar date this happened (e.g., "On August 8, 2025") unless the date itself is the actual point of the story — a "this day in history"/anniversary framing, or the date is what makes it notable. For an ordinary current news pick, just write it as recent/current instead ("recently," "this week," etc.) — a hardcoded date reads as stale the moment it's read after the fact, which defeats the point of it being "trending." (This date guidance doesn't apply if the context above is a quote's attribution rather than a news event — just use it accurately as given.)`
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
  const openerNote = `\n\nFor the second paragraph's opening sentence specifically, use this exact approach: ${nextOpenerShape()}.`;
  return `TASK: read-more article

Today's date is ${today}.

Path so far: ${path.join(" → ")}
Topic: "${topicLabel}"${newsNote}${titleNote}${openerNote}`;
}
