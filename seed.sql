-- 1C. Seed data
-- Edit the profile row below with your real details before running.

INSERT INTO profile (
  id, nationality, degree, profession, experience_years,
  skills, languages, current_country, desired_countries,
  industries, interests, updated_at
) VALUES (
  1,
  'Nigerian',
  'LLB',
  'Lawyer',
  5,
  '["litigation","compliance","legal writing","legal tech"]',
  '["English"]',
  'Nigeria',
  '["United Kingdom","United States","Canada","Remote"]',
  '["legal","compliance","legal tech","development sector"]',
  '["scholarships","fellowships","legal tech grants","remote legal work"]',
  '2026-07-08'
);

-- Curated sources across ALL categories — scholarships, grants, fellowships,
-- NGO roles, general jobs/graduate-trainee roles, and money/freelance.
-- Deliberately broad per user preference: "I need all, I don't want to
-- restrict myself." crawl_frequency and category feed Phase 3 cron logic.

INSERT INTO sources (name, url, category, crawl_frequency, active) VALUES
  -- Scholarships / fellowships
  ('Chevening Scholarships', 'https://www.chevening.org/scholarships/', 'scholarship', 'weekly', 1),
  ('Commonwealth Scholarships', 'https://cscuk.fcdo.gov.uk/scholarships/', 'scholarship', 'weekly', 1),
  ('Mastercard Foundation Scholars Program', 'https://mastercardfdn.org/en/what-we-do/programs/scholars-program/', 'scholarship', 'weekly', 1),
  ('Schwarzman Scholars', 'https://www.schwarzmanscholars.org/admissions/how-to-apply/', 'scholarship', 'weekly', 1),
  ('DAAD Scholarship Database', 'https://www2.daad.de/deutschland/stipendium/datenbank/en/', 'scholarship', 'weekly', 1),
  ('African Union Scholarships Portal', 'https://au.int/en/pressreleases', 'scholarship', 'weekly', 1),
  ('World Bank Careers & Programs', 'https://www.worldbank.org/en/about/careers', 'fellowship', 'weekly', 1),

  -- Grants
  ('Mozilla / Google.org tech grants (aggregator search)', 'https://www.google.org/', 'grant', 'weekly', 1),

  -- NGO / development sector roles
  ('UN Careers', 'https://careers.un.org/', 'ngo', 'daily', 1),
  ('ReliefWeb Jobs', 'https://reliefweb.int/jobs', 'ngo', 'daily', 1),
  ('Devex Jobs', 'https://www.devex.com/jobs', 'ngo', 'daily', 1),
  ('Idealist Jobs', 'https://www.idealist.org/en/jobs', 'ngo', 'daily', 1),
  ('NGO Jobs in Africa', 'https://ngojobsinafrica.com/', 'ngo', 'daily', 1),

  -- General jobs & graduate-trainee roles (Nigeria-focused aggregators —
  -- these tend to expose more schema.org JobPosting JSON-LD than corporate
  -- career pages, and are the best defense against scraping fake postings
  -- straight off Google search results)
  ('Jobberman Nigeria', 'https://www.jobberman.com/jobs', 'job', 'daily', 1),
  ('MyJobMag Nigeria', 'https://www.myjobmag.com/', 'job', 'daily', 1),
  ('Prosple Nigeria Graduate Programs', 'https://ng.prosple.com/graduate-employers', 'job', 'weekly', 1),

  -- Money / freelance
  ('Upwork (saved search feed)', 'https://www.upwork.com/nx/jobs/search/', 'money', 'daily', 1);

-- Note: some of these URLs are landing/search pages rather than deep listing
-- pages -- during 1D/1E you'll confirm which ones return clean, extractable
-- text and adjust the URL or stripping logic per source as needed. Sources
-- confirmed as JS-rendered-only dead ends (e.g. PwC Nigeria's own careers
-- page) are intentionally left out here.
