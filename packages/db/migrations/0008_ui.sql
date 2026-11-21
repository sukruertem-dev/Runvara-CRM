-- 0008 UI core (P6a, docs/p6-plan.md §4): Kanban WIP limit per workflow status; refresh-token grace marker.
-- A soft limit: the board warns when a column holds more open items than this; moves are not blocked.

ALTER TABLE statuses
  ADD COLUMN wip_limit integer CHECK (wip_limit IS NULL OR wip_limit BETWEEN 1 AND 1000);

-- Refresh rotation grace (ADR-0009 note, assumptions B52): a rotated token may be presented once more within
-- 30 s when its successor was never used (the response was lost). The successor consumed that way is marked, and
-- a marked token never gets the grace itself, so two holders cannot keep a stolen family alive by alternating.
ALTER TABLE refresh_tokens
  ADD COLUMN consumed_by_grace boolean NOT NULL DEFAULT false;
