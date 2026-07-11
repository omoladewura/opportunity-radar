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

-- 10 curated sources across categories, per the source list in the build plan.
-- crawl_frequency and category are used by Phase 3 cron logic later.

INSERT INTO sources (name, url, category, crawl_frequency, active) VALUES
  ('Chevening Scholarships', 'https://www.chevening.org/scholarships/', 'scholarship', 'weekly', 1),
  ('Commonwealth Scholarships', 'https://cscuk.fcdo.gov.uk/scholarships/', 'scholarship', 'weekly', 1),
  ('Mastercard Foundation Scholars Program', 'https://mastercardfdn.org/en/what-we-do/programs/scholars-program/', 'scholarship', 'weekly', 1),
  ('Schwarzman Scholars', 'https://www.schwarzmanscholars.org/admissions/how-to-apply/', 'scholarship', 'weekly', 1),
  ('DAAD Scholarship Database', 'https://www2.daad.de/deutschland/stipendium/datenbank/en/', 'scholarship', 'weekly', 1),
  ('African Union Scholarships Portal', 'https://au.int/en/pressreleases', 'scholarship', 'weekly', 1),
  ('World Bank Careers & Programs', 'https://www.worldbank.org/en/about/careers', 'fellowship', 'weekly', 1),
  ('UN Careers (Legal & Rights roles)', 'https://careers.un.org/', 'job', 'daily', 1),
  ('ReliefWeb Jobs', 'https://reliefweb.int/jobs', 'job', 'daily', 1),
  ('Devex Jobs', 'https://www.devex.com/jobs', 'job', 'daily', 1);

-- Note: some of these URLs are landing/search pages rather than deep listing
-- pages -- during 1D/1E you'll confirm which ones return clean, extractable
-- text and adjust the URL or stripping logic per source as needed.
