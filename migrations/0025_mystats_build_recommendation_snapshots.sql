-- Immutable per-patch recommendation signatures for My Stats build adherence.
--
-- A boolean in my_matches is measured only against this game's OWN patch. The
-- recommendation engine exposes only its current populated patch, so capture
-- the first valid signature seen for each (patch, champion, role). Keeping an
-- existing row unchanged makes this a snapshot rather than a moving pointer:
-- later upstream data refreshes cannot silently reinterpret already-scored
-- games.

CREATE TABLE IF NOT EXISTS coachbuild.my_build_recommendation_snapshots (
  patch text NOT NULL,
  champion_id integer NOT NULL,
  role smallint NOT NULL CHECK (role BETWEEN 0 AND 4),
  keystone_id integer NOT NULL,
  core_item_ids integer[] NOT NULL CHECK (cardinality(core_item_ids) = 3),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patch, champion_id, role)
);

-- Persist the proof that an individual boolean was measured from its own
-- patch's snapshot. Existing non-null booleans were produced by the former
-- exact patch-equality gate, so they retain their measured status.
ALTER TABLE coachbuild.my_matches
  ADD COLUMN IF NOT EXISTS wpa_recommendation_patch text;

UPDATE coachbuild.my_matches
SET wpa_recommendation_patch = patch
WHERE on_wpa_build IS NOT NULL
  AND wpa_recommendation_patch IS NULL;

ALTER TABLE coachbuild.my_matches
  ADD CONSTRAINT my_matches_wpa_recommendation_patch_check
  CHECK (
    (on_wpa_build IS NULL AND wpa_recommendation_patch IS NULL)
    OR (on_wpa_build IS NOT NULL AND wpa_recommendation_patch = patch)
  );
