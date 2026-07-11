-- Your profile (single row, not a users table)
CREATE TABLE profile (
  id INTEGER PRIMARY KEY,
  nationality TEXT,
  degree TEXT,
  profession TEXT,
  experience_years INTEGER,
  skills TEXT,             -- JSON array
  languages TEXT,          -- JSON array
  current_country TEXT,
  desired_countries TEXT,  -- JSON array
  industries TEXT,         -- JSON array
  interests TEXT,          -- JSON array
  updated_at TEXT
);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  name TEXT,
  url TEXT,
  category TEXT,           -- scholarship | grant | fellowship | job | money
  crawl_frequency TEXT,    -- daily | weekly
  active INTEGER DEFAULT 1,
  last_crawled_at TEXT
);

CREATE TABLE opportunities (
  id INTEGER PRIMARY KEY,
  source_id INTEGER,
  title TEXT,
  organization TEXT,
  category TEXT,
  country TEXT,
  deadline TEXT,
  funding_amount TEXT,
  salary TEXT,
  eligibility_summary TEXT,
  requirements TEXT,       -- JSON array
  application_link TEXT,
  raw_extract TEXT,        -- full AI extraction JSON, for audit
  match_score INTEGER,     -- 0-100, computed against profile
  eligibility_status TEXT, -- eligible | partial | not_eligible
  scam_risk TEXT,          -- low | medium | high
  scam_reasons TEXT,       -- JSON array of short flags, e.g. ["upfront payment requested","no verifiable company domain"]
  status TEXT DEFAULT 'new', -- new | saved | applied | dismissed
  discovered_at TEXT,
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  opportunity_id INTEGER,
  note TEXT,
  created_at TEXT
);

-- Scratch table for Phase 1D: proves the fetch -> strip -> store round trip
-- before any AI extraction is wired in. Safe to keep around for debugging
-- bad scrapes later (compare raw_text against what the extractor saw).
CREATE TABLE raw_pages (
  id INTEGER PRIMARY KEY,
  source_id INTEGER,
  url TEXT,
  raw_text TEXT,
  fetched_at TEXT,
  FOREIGN KEY (source_id) REFERENCES sources(id)
);
