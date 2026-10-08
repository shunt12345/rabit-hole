-- Rejected hero picks are now deleted on reject (admin-review-queue)
-- instead of kept; this clears out the ones rejected before that.
delete from trending_topics_cache where status = 'rejected';
