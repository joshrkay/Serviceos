-- ServiceOS Training Pipeline — Supabase Schema
-- Run in Supabase SQL Editor → New Query → paste → Run
--
-- Creates the corpus + lookup tables that the Mac mini Reddit processor
-- writes into, plus the read-side views used by the voice agent and QA.

-- ============================================================
-- Extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- training_corpus
--   One row per ingested document (Reddit post, synthetic call,
--   transcript, etc). Embedding is nullable so we can backfill
--   in a later pass.
-- ============================================================
CREATE TABLE IF NOT EXISTS training_corpus (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source          TEXT NOT NULL,                 -- 'reddit', 'synthetic', 'transcript'
  source_id       TEXT NOT NULL,                 -- subreddit:postid, etc.
  raw_text        TEXT NOT NULL,
  normalized_text TEXT NOT NULL,                 -- after phrase_map substitution
  triage          TEXT NOT NULL CHECK (triage IN ('emergency','urgent','routine','info','unknown')),
  trade           TEXT NOT NULL CHECK (trade IN ('plumbing','hvac','electrical','general','diy','unknown')),
  fixture         TEXT,                          -- 'water_heater','toilet','condenser', etc.
  accent          TEXT,                          -- 'southern_us','boston','aave','spanish_es', etc.
  language        TEXT NOT NULL DEFAULT 'en',
  region_hint     TEXT,                          -- subreddit-derived region if any
  phrases_hit     TEXT[] NOT NULL DEFAULT '{}',  -- which phrase_map entries fired
  dialect_hits    TEXT[] NOT NULL DEFAULT '{}',  -- which dialect_registry entries fired
  confidence      REAL NOT NULL DEFAULT 0.0,
  embedding       vector(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_training_corpus_source
  ON training_corpus (source, source_id);
CREATE INDEX IF NOT EXISTS idx_training_corpus_triage    ON training_corpus (triage);
CREATE INDEX IF NOT EXISTS idx_training_corpus_trade     ON training_corpus (trade);
CREATE INDEX IF NOT EXISTS idx_training_corpus_accent    ON training_corpus (accent);
CREATE INDEX IF NOT EXISTS idx_training_corpus_fixture   ON training_corpus (fixture);
CREATE INDEX IF NOT EXISTS idx_training_corpus_text_trgm
  ON training_corpus USING gin (normalized_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_training_corpus_embedding
  ON training_corpus USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================
-- phrase_map
--   Layman / regional phrase  →  canonical technical term.
--   Used by the processor to normalize text before classification
--   and at runtime by the voice agent for understanding.
-- ============================================================
CREATE TABLE IF NOT EXISTS phrase_map (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  layman_phrase   TEXT NOT NULL,
  technical_term  TEXT NOT NULL,
  trade           TEXT NOT NULL,
  region          TEXT,
  confidence      REAL NOT NULL DEFAULT 0.9,
  notes           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_phrase_map_unique
  ON phrase_map (lower(layman_phrase), trade);
CREATE INDEX IF NOT EXISTS idx_phrase_map_layman_trgm
  ON phrase_map USING gin (layman_phrase gin_trgm_ops);

INSERT INTO phrase_map (layman_phrase, technical_term, trade, region, notes) VALUES
  ('spicket',         'faucet',         'plumbing', 'southern_us', 'spigot variant'),
  ('spigot',          'faucet',         'plumbing', 'southern_us', NULL),
  ('commode',         'toilet',         'plumbing', 'southern_us', NULL),
  ('john',            'toilet',         'plumbing', 'general',     'slang'),
  ('water closet',    'toilet',         'plumbing', 'general',     NULL),
  ('frigidaire',      'refrigerator',   'general',  'general',     'genericized brand'),
  ('wooder',          'water',          'plumbing', 'philadelphia',NULL),
  ('waddah heatah',   'water heater',   'plumbing', 'boston',      NULL),
  ('hot water tank',  'water heater',   'plumbing', 'general',     NULL),
  ('busted pipe',     'burst pipe',     'plumbing', 'general',     NULL),
  ('pipes are sweating','condensation on pipes','plumbing','general',NULL),
  ('a/c is froze up', 'frozen evaporator coil','hvac','general',  NULL),
  ('furnace is short cycling','short cycling','hvac','general',   NULL),
  ('breaker keeps tripping','overloaded circuit','electrical','general',NULL),
  ('está goteando',   'it is leaking',  'plumbing', 'spanish_es',  'es-MX/es-US'),
  ('inodoro',         'toilet',         'plumbing', 'spanish_es',  NULL),
  ('calentador de agua','water heater', 'plumbing', 'spanish_es',  NULL),
  ('tore up',         'broken',         'general',  'aave',        NULL),
  ('actin up',        'malfunctioning', 'general',  'aave',        NULL)
ON CONFLICT DO NOTHING;

-- ============================================================
-- dialect_registry
--   Phrases / patterns that signal a regional accent or dialect.
--   The processor scans normalized text against `pattern` (regex,
--   case-insensitive) and tags `training_corpus.accent`.
-- ============================================================
CREATE TABLE IF NOT EXISTS dialect_registry (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  accent      TEXT NOT NULL,                  -- 'southern_us','boston','nyc','aave','spanish_es', etc.
  language    TEXT NOT NULL DEFAULT 'en',
  pattern     TEXT NOT NULL,                  -- python regex
  example     TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_dialect_registry_accent ON dialect_registry (accent);

INSERT INTO dialect_registry (accent, language, pattern, example, weight) VALUES
  ('southern_us', 'en', '\bspicket\b',                'my spicket is drippin',           1.0),
  ('southern_us', 'en', '\bcommode\b',                'water round the commode',         0.8),
  ('southern_us', 'en', '\by''?all\b',                 'y''all got a plumber?',            0.7),
  ('southern_us', 'en', '\bfixin[''\s]to\b',          'fixin to call somebody',          0.9),
  ('southern_us', 'en', '\breckon\b',                 'reckon it''s the heater',          0.7),
  ('southern_us', 'en', '\bdrippin\b|\bleakin\b',     'drippin off the commode',         0.6),
  ('boston',      'en', '\bwaddah\b',                  'my waddah heatah',                1.0),
  ('boston',      'en', '\bheatah\b',                  'water heatah is busted',          0.9),
  ('boston',      'en', '\bwicked\b',                  'wicked bad leak',                 0.6),
  ('boston',      'en', '\bcah\b',                     'cah is in the driveway',          0.4),
  ('nyc',         'en', '\bschmutz\b',                 'schmutz in the drain',            0.7),
  ('nyc',         'en', '\bawn line\b',                'plumber is awn line',             0.5),
  ('philadelphia','en', '\bwooder\b',                  'no wooder pressure',              1.0),
  ('philadelphia','en', '\byous\b',                    'yous gotta come out',             0.6),
  ('chicago',     'en', '\bda\b\s+(furnace|toilet|sink|pipe)','da furnace died',         0.6),
  ('appalachian', 'en', '\bholler\b',                  'down in the holler',              0.7),
  ('appalachian', 'en', '\bbuggin\b',                  'pipes been buggin',               0.4),
  ('texas',       'en', '\bfixin to\b',                'fixin to bust',                   0.6),
  ('texas',       'en', '\bswamp cooler\b',            'swamp cooler quit',               0.6),
  ('cajun',       'en', '\bcher\b',                    'help me cher',                    0.6),
  ('cajun',       'en', '\bmais\b',                    'mais it''s leakin',                0.5),
  ('aave',        'en', '\btore up\b',                 'pipes is tore up real bad',       0.7),
  ('aave',        'en', '\bactin[''\s]?up\b',          'a/c actin up',                    0.7),
  ('aave',        'en', '\bain''?t\s+got\s+no\b',      'ain''t got no hot water',          0.6),
  ('upper_midwest','en','\bdon''?cha know\b',           'cold in here don''t cha know',     0.6),
  ('upper_midwest','en','\boh\s+geez\b',                'oh geez the basement is wet',     0.5),
  ('uk',          'en', '\bboiler\b.*\bknackered\b',   'boiler is knackered',             0.9),
  ('uk',          'en', '\btap\b.*\bdripping\b',       'kitchen tap dripping',            0.5),
  ('aus',         'en', '\bdunny\b',                   'dunny won''t flush',               0.9),
  ('spanish_es',  'es', '\bestá\s+goteando\b',         'está goteando el inodoro',        1.0),
  ('spanish_es',  'es', '\binodoro\b',                 'inodoro tapado',                  0.9),
  ('spanish_es',  'es', '\bcalentador\s+de\s+agua\b', 'calentador de agua roto',         0.9),
  ('spanish_es',  'es', '\bno\s+hay\s+agua\s+caliente\b','no hay agua caliente',         1.0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- synthetic_calls
--   Filled later by the Claude synthetic-call generator. Keeps the
--   same shape as a real transcript so downstream code is identical.
-- ============================================================
CREATE TABLE IF NOT EXISTS synthetic_calls (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scenario        TEXT NOT NULL,
  trade           TEXT NOT NULL,
  triage          TEXT NOT NULL,
  accent          TEXT,
  language        TEXT NOT NULL DEFAULT 'en',
  transcript      JSONB NOT NULL,          -- [{role, text, ts_ms}, ...]
  expected_intent JSONB,                   -- gold label for eval
  generator       TEXT NOT NULL DEFAULT 'claude-opus-4-7',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_synthetic_calls_trade  ON synthetic_calls (trade);
CREATE INDEX IF NOT EXISTS idx_synthetic_calls_triage ON synthetic_calls (triage);
CREATE INDEX IF NOT EXISTS idx_synthetic_calls_accent ON synthetic_calls (accent);

-- ============================================================
-- Views
-- ============================================================

-- corpus_stats: one-glance distribution check after each run
CREATE OR REPLACE VIEW corpus_stats AS
SELECT
  source,
  trade,
  triage,
  accent,
  language,
  count(*)                         AS n,
  avg(confidence)::numeric(4,3)    AS avg_confidence,
  count(*) FILTER (WHERE embedding IS NULL) AS missing_embeddings
FROM training_corpus
GROUP BY source, trade, triage, accent, language
ORDER BY n DESC;

-- emergency_signals: high-recall feed for the voice agent's emergency
-- phrase library — used to tune the "did the caller say something
-- urgent" classifier.
CREATE OR REPLACE VIEW emergency_signals AS
SELECT
  id,
  trade,
  fixture,
  accent,
  language,
  normalized_text,
  raw_text,
  phrases_hit,
  dialect_hits,
  confidence,
  created_at
FROM training_corpus
WHERE triage IN ('emergency','urgent')
ORDER BY confidence DESC, created_at DESC;

-- review_queue: low-confidence rows a human should look at before we
-- promote them into the voice agent's training set.
CREATE OR REPLACE VIEW review_queue AS
SELECT
  id,
  source,
  source_id,
  trade,
  triage,
  accent,
  confidence,
  raw_text,
  normalized_text,
  created_at
FROM training_corpus
WHERE confidence < 0.5
   OR triage = 'unknown'
   OR trade  = 'unknown'
ORDER BY created_at DESC;
