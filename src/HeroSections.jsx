// The hero page's daily picks, in page order: the date, Trending, the
// riddle, Today, Perspective, then Quote of the Day. Each card credits its
// source outlet ("via npr.org") — never the riddle's, which would give the
// answer away. Each card opens its
// topic through onStartTopic; the tapped card stays highlighted while it
// loads. The picks themselves come from lib/heroPicks.js.
import { useState } from "react";
import { HelpCircle } from "lucide-react";
import RiddleGame from "./RiddleGame.jsx";
import ThreadTitle from "./ThreadTitle.jsx";
import SourceCredit from "./SourceCredit.jsx";
import {
  heroPicks,
  mostRecentDate,
  NEWS_FIELD_LABELS,
  QUOTE_FIELD,
  RIDDLE_FIELD,
  PERSPECTIVE_FIELD,
  storyContext,
} from "./lib/heroPicks.js";

export default function HeroSections({ trendingTopics, previewRiddle, visible, rootLoading, user, onStartTopic, onSignUp, adSlot, threadOfDay, onOpenThread }) {
  const { newsTopics, todayTopics, quoteTopic, riddleTopic, perspectiveTopic } = heroPicks(trendingTopics, previewRiddle);
  // Which card was tapped ("quote", "today-0", "news-1", ...).
  const [selectedKey, setSelectedKey] = useState(null);

  // On a wide screen (lg) the sections sit in a two-column grid so the page
  // fills the screen: the Hyfax of the Day beside the riddle, the two
  // Trending stories side by side, then Today's two, then Perspective
  // beside the quote. The lg:order classes set that order; phones and
  // small tablets keep the single column in page order.
  return (
    <div className="lg:grid lg:grid-cols-2 lg:gap-x-6 lg:items-start">
      {/* Date badge — the whole batch's freshness, once, up front. Uses
          the most recent publish across every field, since they all
          refresh together on the same once-daily cron. */}
      {trendingTopics.length > 0 && (
        <div className="mt-10 rh-mono text-lg font-semibold lg:col-span-2 lg:order-1" style={{ color: "#E3A73C" }}>
          {mostRecentDate(trendingTopics).toLocaleDateString(undefined, {
            month: "long",
            day: "numeric",
          })}
        </div>
      )}

      {/* The Hyfax of the Day (lib/chains.js): the day's four-step thread,
          first thing on the page. Only its "A to B" title: the steps in
          between are the fun of opening it. Opening it counts as one page. */}
      {threadOfDay && (
        <button
          type="button"
          onClick={() => onOpenThread(threadOfDay)}
          disabled={rootLoading}
          className="rh-chip mt-3 w-full max-w-md lg:max-w-none mx-auto text-left p-5 rounded-2xl border-2 transition-colors block lg:order-2"
          style={{ borderColor: "#E3A73C", background: "linear-gradient(160deg,#2E2216,#1F1811)" }}
        >
          <span className="rh-mono text-xs uppercase tracking-wider font-semibold" style={{ color: "#E3A73C" }}>
            Hyfax of the Day
          </span>
          <span className="block mt-3">
            <ThreadTitle title={threadOfDay.title} />
          </span>
          <span className="block rh-body text-sm mt-3" style={{ color: "#A89478" }}>
            Four steps on one thread
          </span>
          <span className="block rh-body text-sm font-semibold mt-3" style={{ color: "#E3A73C" }}>
            Follow the thread →
          </span>
        </button>
      )}

      {/* Order: Trending first (what visitors half-saw in their feed, and
          why it matters), then the riddle (the daily game), then Today,
          Perspective, and the quote as a closing note. */}

      {/* Trending: real, live-searched stories (see
          supabase/functions/generate-trending-topics). */}
      {newsTopics.length > 0 && visible.news && (
        <div className="mt-3 lg:mt-10 lg:col-span-2 lg:order-4">
          <div className="flex items-center justify-center gap-1.5 mb-6">
            <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: "#C9B896" }}>
              Trending
            </span>
          </div>
          <div className={`flex flex-col gap-3 max-w-md mx-auto ${newsTopics.length > 1 ? "lg:grid lg:grid-cols-2 lg:gap-6 lg:max-w-none" : ""}`}>
            {newsTopics.map((t, i) => {
              const isSelected = selectedKey === `news-${i}`;
              return (
                <button
                  data-precompute="hero"
                  key={`${t.field}-${i}`}
                  type="button"
                  onClick={() => {
                    setSelectedKey(`news-${i}`);
                    onStartTopic(t.topic, storyContext(t), t.field);
                  }}
                  disabled={rootLoading}
                  className={`rh-chip text-left p-4 rounded-2xl border transition-colors ${
                    rootLoading && !isSelected ? "opacity-40" : ""
                  } ${rootLoading && isSelected ? "cursor-default" : ""}`}
                  style={{
                    borderColor: isSelected ? "#E3A73C" : "#4A3826",
                    backgroundColor: isSelected ? "#2A2015" : "#241B12",
                  }}
                >
                  <span className="rh-mono text-xs uppercase tracking-wider font-semibold" style={{ color: "#E3A73C" }}>
                    {NEWS_FIELD_LABELS[t.field] || t.field}
                  </span>
                  <div className="rh-body text-lg font-semibold mt-1" style={{ color: "#F1E6D3" }}>
                    {t.topic}
                  </div>
                  <p className="rh-body text-sm mt-1" style={{ color: "#B8A886" }}>
                    {t.teaser}
                  </p>
                  <div className="mt-2 text-right">
                    <SourceCredit url={t.source_url} />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* The riddle: the guessing game ("What am I?", see RiddleGame.jsx)
          for a riddle curated with game pieces, which opens the answer with
          its clues as threads; an older riddle without them keeps the
          one-tap card. Its own toggle (featureRiddle), so a funded user
          can turn it off independently. */}
      {riddleTopic && visible.riddle && riddleTopic.riddle_game && (
        <RiddleGame
          riddle={riddleTopic}
          className="lg:order-3 lg:mt-3"
          user={user}
          onSignUp={onSignUp}
          disabled={rootLoading}
          onOpenAnswer={() => {
            setSelectedKey("riddle");
            // The answer page's threads are the clues just solved.
            onStartTopic(
              riddleTopic.topic,
              riddleTopic.teaser,
              RIDDLE_FIELD,
              riddleTopic.riddle_game.clues.map((c, i) => ({
                label: c.title,
                teaser: c.teaser,
                type: i < 2 ? "indirect" : "tangent",
                pinned: true,
              }))
            );
          }}
        />
      )}
      {riddleTopic && visible.riddle && !riddleTopic.riddle_game && (
        <div className="mt-10 lg:order-3 lg:mt-3">
          <div className="flex items-center justify-center gap-1.5 mb-6 lg:hidden">
            <HelpCircle size={14} style={{ color: "#C9B896" }} />
            <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: "#C9B896" }}>
              Riddle me this....
            </span>
          </div>
          <div className="max-w-md mx-auto lg:max-w-none">
            <button
              data-precompute="hero"
              type="button"
              onClick={() => {
                setSelectedKey("riddle");
                onStartTopic(riddleTopic.topic, riddleTopic.teaser, RIDDLE_FIELD);
              }}
              disabled={rootLoading}
              className={`rh-chip text-left p-5 rounded-2xl border transition-colors w-full ${
                rootLoading && !selectedKey === "riddle" ? "opacity-40" : ""
              } ${rootLoading && selectedKey === "riddle" ? "cursor-default" : ""}`}
              style={{
                borderColor: selectedKey === "riddle" ? "#E3A73C" : "#4A3826",
                backgroundColor: selectedKey === "riddle" ? "#2A2015" : "#241B12",
              }}
            >
              <p className="rh-display italic text-lg leading-relaxed" style={{ color: "#F1E6D3" }}>
                {riddleTopic.teaser}
              </p>
            </button>
          </div>
        </div>
      )}

      {adSlot && <div className="lg:col-span-2 lg:order-5">{adSlot}</div>}

      {/* "Today" — This Day In History + Word Of The Day, same
          source table and card treatment as "Trending"
          but date-anchored/evergreen rather than searched-for-recency.
          See promptForField in supabase/functions/generate-trending-topics.
          Same funded-only gate as "Trending" below. */}
      {todayTopics.length > 0 && visible.today && (
        <div className="mt-10 lg:col-span-2 lg:order-6">
          <div className="flex items-center justify-center gap-1.5 mb-6">
            <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: "#C9B896" }}>
              Today
            </span>
          </div>
          {/* A day with one pick (the other missing or stale) centres it
              rather than leaving half the wide row empty. */}
          <div className={`flex flex-col gap-3 max-w-md mx-auto ${todayTopics.length > 1 ? "lg:grid lg:grid-cols-2 lg:gap-6 lg:max-w-none" : ""}`}>
            {todayTopics.map((t, i) => {
              const isSelected = selectedKey === `today-${i}`;
              return (
                <button
                  data-precompute="hero"
                  key={`${t.field}-${i}`}
                  type="button"
                  onClick={() => {
                    setSelectedKey(`today-${i}`);
                    onStartTopic(t.topic, t.teaser, t.field);
                  }}
                  disabled={rootLoading}
                  className={`rh-chip text-left p-4 rounded-2xl border transition-colors ${
                    rootLoading && !isSelected ? "opacity-40" : ""
                  } ${rootLoading && isSelected ? "cursor-default" : ""}`}
                  style={{
                    borderColor: isSelected ? "#E3A73C" : "#4A3826",
                    backgroundColor: isSelected ? "#2A2015" : "#241B12",
                  }}
                >
                  <span className="rh-mono text-xs uppercase tracking-wider font-semibold" style={{ color: "#E3A73C" }}>
                    {t.field}
                  </span>
                  <div className="rh-body text-lg font-semibold mt-1" style={{ color: "#F1E6D3" }}>
                    {t.topic}
                  </div>
                  <p className="rh-body text-sm mt-1" style={{ color: "#B8A886" }}>
                    {t.teaser}
                  </p>
                  <div className="mt-2 text-right">
                    <SourceCredit url={t.source_url} />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* "Perspective" — same source table/cron cadence as "Today,"
          but its own dedicated single-item card rather than grouped
          into that list, same reasoning as Quote Of The Day/Riddle
          above. Reframes one specific thing by shifting scale (zoom
          in to the microscopic, or out to the cosmic) instead of
          searching for recency — see perspectivePrompt in
          generate-trending-topics. Rotates through a fixed
          Human/Nature/Space sequence server-side (one per day, not
          model-chosen — see nextPerspectiveFocus). Unlike Riddle/
          Quote, this field's category (the Human/Nature/Space focus)
          and direction (micro/macro, see migration 0048) ARE shown
          here, in place of the badge just repeating the section
          header's own "Perspective" label right above it. Reuses the
          "Today" feature toggle (visible.today) rather than adding a
          whole new one for a single field, same call Quote Of The
          Day already made. */}
      {perspectiveTopic && visible.today && (
        <div className="mt-10 lg:order-7 lg:self-stretch lg:flex lg:flex-col">
          <div className="flex items-center justify-center gap-1.5 mb-6">
            <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: "#C9B896" }}>
              Perspective
            </span>
          </div>
          <div className="max-w-md mx-auto lg:max-w-none lg:w-full lg:flex-1">
            <button
              data-precompute="hero"
              type="button"
              onClick={() => {
                setSelectedKey("perspective");
                onStartTopic(perspectiveTopic.topic, perspectiveTopic.teaser, PERSPECTIVE_FIELD);
              }}
              disabled={rootLoading}
              className={`rh-chip text-left p-4 rounded-2xl border transition-colors w-full lg:h-full ${
                rootLoading && !selectedKey === "perspective" ? "opacity-40" : ""
              } ${rootLoading && selectedKey === "perspective" ? "cursor-default" : ""}`}
              style={{
                borderColor: selectedKey === "perspective" ? "#E3A73C" : "#4A3826",
                backgroundColor: selectedKey === "perspective" ? "#2A2015" : "#241B12",
              }}
            >
              <span className="rh-mono text-xs uppercase tracking-wider font-semibold" style={{ color: "#E3A73C" }}>
                {[perspectiveTopic.category, perspectiveTopic.direction].filter(Boolean).join(" · ") || "Perspective"}
              </span>
              <div className="rh-body text-lg font-semibold mt-1" style={{ color: "#F1E6D3" }}>
                {perspectiveTopic.topic}
              </div>
              <p className="rh-body text-sm mt-1" style={{ color: "#B8A886" }}>
                {perspectiveTopic.teaser}
              </p>
              <div className="mt-2 text-right">
                <SourceCredit url={perspectiveTopic.source_url} />
              </div>
            </button>
          </div>
        </div>
      )}

      {/* Quote Of The Day — same source table/cron cadence as "Today"
          (see promptForField in generate-trending-topics), but its own
          section (last on the page) rather than grouped into the
          "Today" list, since a full quote needs more visual room
          than a short topic label + teaser. Reuses the "Today"
          feature toggle for gating (visible.today) rather than adding
          a whole new toggle for one field. Clickable the same way as
          every other card — the quote text itself becomes the topic
          dug into, with the author/context teaser passed through as
          newsContext so the resulting article covers the quote's
          real history, significance, and author (see ARTICLE_TASK's
          dedicated Quote Of The Day guidance in hyfaxSystemPrompt.js). */}
      {quoteTopic && visible.today && (
        <div className="mt-10 lg:order-8 lg:self-stretch lg:flex lg:flex-col">
          <div className="flex items-center justify-center gap-1.5 mb-6">
            <span className="rh-mono text-sm uppercase tracking-wider" style={{ color: "#C9B896" }}>
              Quote of the Day
            </span>
          </div>
          <div className="max-w-md mx-auto lg:max-w-none lg:w-full lg:flex-1">
            <button
              data-precompute="hero"
              type="button"
              onClick={() => {
                setSelectedKey("quote");
                onStartTopic(quoteTopic.topic, quoteTopic.teaser, QUOTE_FIELD);
              }}
              disabled={rootLoading}
              className={`rh-chip text-left p-5 rounded-2xl border transition-colors w-full lg:h-full ${
                rootLoading && selectedKey !== "quote" ? "opacity-40" : ""
              } ${rootLoading && selectedKey === "quote" ? "cursor-default" : ""}`}
              style={{
                borderColor: selectedKey === "quote" ? "#E3A73C" : "#4A3826",
                backgroundColor: selectedKey === "quote" ? "#2A2015" : "#241B12",
              }}
            >
              <div className="rh-display italic text-xl leading-snug" style={{ color: "#F1E6D3" }}>
                {quoteTopic.topic}
              </div>
              <p className="rh-body text-sm mt-3" style={{ color: "#B8A886" }}>
                {quoteTopic.teaser}
              </p>
              <div className="mt-2 text-right">
                <SourceCredit url={quoteTopic.source_url} />
              </div>
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
