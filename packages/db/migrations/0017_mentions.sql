-- P8c (docs/p8-plan.md §13): mentions in notes and descriptions, not only in comments.
ALTER TABLE mentions DROP CONSTRAINT mentions_source_type_check;
ALTER TABLE mentions ADD CONSTRAINT mentions_source_type_check CHECK (source_type IN ('comment', 'note', 'description'));
-- Rate limit per author.
CREATE INDEX mentions_author ON mentions (tenant_id, mentioned_by, created_at DESC);
