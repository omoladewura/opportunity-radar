export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  RESEND_API_KEY: string;
  DIGEST_TO_EMAIL: string;   // where the digest gets sent -- you
  DIGEST_FROM_EMAIL: string; // e.g. "digest@yourdomain.com" once verified in Resend
}

// Only opportunities scoring at or above this get emailed. Jobs/NGO roles in
// your test run scored 5-50, so 40 is a reasonable "worth a look" bar --
// adjust freely once you see real digest volume.
const DIGEST_MIN_SCORE = 40;

// After this many consecutive fetch/extract failures, a source is flagged
// dead and deactivated so cron stops burning Claude API calls on it.
const DEAD_SOURCE_THRESHOLD = 3;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchAndStore(
  env: Env,
  sourceId: number,
  url: string
): Promise<{ ok: boolean; length: number; preview: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "opportunity-radar/0.1 (personal use)" },
  });
  const html = await res.text();
  const text = stripHtml(html);

  await env.DB.prepare(
    `INSERT INTO raw_pages (source_id, url, raw_text, fetched_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(sourceId, url, text, new Date().toISOString())
    .run();

  await env.DB.prepare(
    `UPDATE sources SET last_crawled_at = ? WHERE id = ?`
  )
    .bind(new Date().toISOString(), sourceId)
    .run();

  return { ok: res.ok, length: text.length, preview: text.slice(0, 500) };
}


interface ExtractedOpportunity {
  title: string;
  organization: string;
  category: "scholarship" | "grant" | "fellowship" | "job" | "ngo" | "money";
  country: string;
  deadline: string | null;
  funding_amount: string | null;
  salary: string | null;
  eligibility: string;
  requirements: string[];
  application_link: string | null;
  scam_risk: "low" | "medium" | "high";
  scam_reasons: string[];
}

async function callClaude(
  env: Env,
  system: string,
  userText: string,
  maxTokens: number = 2000
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error ${res.status}: ${body}`);
  }

  const data = await res.json<any>();
  const text = (data.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();

  if (data.stop_reason === "max_tokens") {
    throw new Error(
      `Response was cut off (hit max_tokens=${maxTokens}) before finishing. Raise maxTokens for this call or shrink the input.`
    );
  }

  return text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
}

const EXTRACTION_SYSTEM = `You are extracting structured data from a scraped opportunity listing page (scholarship, grant, fellowship, NGO role, job/graduate-trainee posting, or money-making gig). The page may contain multiple listings mixed with navigation or template noise -- ignore the noise, find the real listing(s).

For each listing, assess scam/fraud risk carefully and skeptically -- treat this as the most important field, since a missed scam is far more costly than a false alarm on a real listing. Nigerian job/scholarship seekers are a heavily targeted group, especially for postings surfaced via Google search rather than a verified employer site. Look for these signals:
- Any request for upfront payment, "training fee", "processing fee", "registration fee", refundable deposit, or bank/card details before hiring/admission
- Contact only via WhatsApp/Telegram/personal email (gmail/yahoo/outlook) with no verifiable company domain, website, or physical address
- Salary/funding amount unusually high for the stated role, location, experience level, or requirements
- Urgency or pressure language ("apply within 24 hours", "limited slots", "immediate start, no interview", "act now")
- Vague or generic company description, stock-photo-style branding, or no way to independently verify the organization exists
- Application process that redirects off-platform to an unrelated, unofficial, or suspicious site, or asks for application via a file-sharing/chat link rather than a standard ATS or company site
- Requests for sensitive personal documents (ID, passport, bank statement) before any interview or offer
- Payment or compensation offered via cryptocurrency, gift cards, or wire transfer to an individual rather than a company account
- Poor grammar/spelling or inconsistent formatting in what claims to be an official corporate or institutional posting
- No interview process described at all ("hired immediately upon application")
- Listing is a duplicate of a real, well-known organization's name but with mismatched contact details or domain (impersonation)

Score conservatively: if you are genuinely unsure whether a signal is present, treat it as present. Zero signals -> "low". Exactly one soft signal (e.g. only generic company description, or only mild urgency language) -> "medium". Two or more signals, OR any single hard signal (upfront payment/fee request, requests for bank/ID details pre-offer, crypto/gift-card payment, impersonation of a real organization) -> "high". When in doubt between two levels, pick the higher-risk one.

Return ONLY valid JSON, no preamble, no markdown fences: an array of objects, each matching this schema:
{
  "title": string,
  "organization": string,
  "category": "scholarship"|"grant"|"fellowship"|"job"|"ngo"|"money",
  "country": string,
  "deadline": string | null,
  "funding_amount": string | null,
  "salary": string | null,
  "eligibility": string,
  "requirements": string[],
  "application_link": string | null,
  "scam_risk": "low"|"medium"|"high",
  "scam_reasons": string[]
}
If the page contains no real listings (e.g. an empty search widget, a nav-only page), return an empty array [].`;


function matchSystem(profile: any): string {
  return `You score how well a job/scholarship/grant listing matches this candidate profile, on a 0-100 scale.

Candidate profile:
${JSON.stringify(profile)}

For each listing given, return ONLY valid JSON, no preamble, no markdown fences: an array of objects:
{ "index": number, "match_score": number (0-100), "eligibility_status": "eligible"|"partial"|"not_eligible", "reason": string (one line) }
"index" refers to the listing's position (0-based) in the input array.`;
}

function extractJsonArray(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.search(/[[{]/);
    const lastBracket = raw.lastIndexOf("]");
    const lastBrace = raw.lastIndexOf("}");
    const end = Math.max(lastBracket, lastBrace);
    if (start === -1 || end === -1 || end < start) {
      throw new Error("no JSON-like content found");
    }
    return JSON.parse(raw.slice(start, end + 1));
  }
}

async function extractAndMatch(
  env: Env,
  sourceId: number,
  rawText: string
): Promise<{ inserted: number; skipped: number }> {
  // NOTE: this used to slice at 12000 chars, which was fine for sources with
  // a short nav section but silently cut off ALL real listings on
  // menu-heavy pages (e.g. HotNigerianJobs' category/role/state filter list
  // runs tens of thousands of characters before any actual job posting).
  // 60000 chars gives real headroom; Claude's context window handles it easily.
  const extractionRaw = await callClaude(
    env,
    EXTRACTION_SYSTEM,
    `Page content:\n${rawText.slice(0, 60000)}`,
    16000 // was 8000 -- pages with 30-40+ listings (like HotNigerianJobs) need more room
  );

  let listings: ExtractedOpportunity[];
  try {
    listings = extractJsonArray(extractionRaw);
  } catch {
    throw new Error(`Extraction returned non-JSON: ${extractionRaw.slice(0, 300)}`);
  }

  if (!Array.isArray(listings) || listings.length === 0) {
    return { inserted: 0, skipped: 0 };
  }

  const profile = await env.DB.prepare(`SELECT * FROM profile WHERE id = 1`).first();

  const matchRaw = await callClaude(
    env,
    matchSystem(profile),
    `Listings:\n${JSON.stringify(listings)}`,
    6000 // was defaulting to 2000 -- too small once a page yields 30-40 listings to score
  );

  let scores: { index: number; match_score: number; eligibility_status: string; reason: string }[];
  try {
    scores = extractJsonArray(matchRaw);
  } catch {
    throw new Error(`Matching returned non-JSON: ${matchRaw.slice(0, 300)}`);
  }
  const scoreByIndex = new Map(scores.map((s) => [s.index, s]));

  let inserted = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < listings.length; i++) {
    const o = listings[i];
    const existing = await env.DB.prepare(
      `SELECT id FROM opportunities WHERE source_id = ? AND title = ? AND organization = ?`
    )
      .bind(sourceId, o.title, o.organization)
      .first();
    if (existing) {
      skipped++;
      continue;
    }

    const s = scoreByIndex.get(i);

    await env.DB.prepare(
      `INSERT INTO opportunities
       (source_id, title, organization, category, country, deadline, funding_amount,
        salary, eligibility_summary, requirements, application_link, raw_extract,
        match_score, eligibility_status, scam_risk, scam_reasons, status, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
    )
      .bind(
        sourceId,
        o.title,
        o.organization,
        o.category,
        o.country ?? null,
        o.deadline ?? null,
        o.funding_amount ?? null,
        o.salary ?? null,
        o.eligibility ?? null,
        JSON.stringify(o.requirements ?? []),
        o.application_link ?? null,
        JSON.stringify(o),
        s?.match_score ?? null,
        s?.eligibility_status ?? null,
        o.scam_risk ?? null,
        JSON.stringify(o.scam_reasons ?? []),
        now
      )
      .run();
    inserted++;
  }

  return { inserted, skipped };
}

function isDue(source: { crawl_frequency: string; last_crawled_at: string | null }): boolean {
  if (!source.last_crawled_at) return true; // never crawled -> due

  const last = new Date(source.last_crawled_at).getTime();
  const now = Date.now();
  const hoursSince = (now - last) / (1000 * 60 * 60);

  if (source.crawl_frequency === "weekly") return hoursSince >= 24 * 7 - 1; // small buffer
  // default to daily behavior for "daily" or any unrecognized value
  return hoursSince >= 24 - 1;
}

async function recordSourceFailure(
  env: Env,
  sourceId: number,
  errorMessage: string
): Promise<{ newlyFlagged: boolean; failureCount: number }> {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT consecutive_failures FROM sources WHERE id = ?`
  )
    .bind(sourceId)
    .first<{ consecutive_failures: number }>();

  const failureCount = (row?.consecutive_failures ?? 0) + 1;
  const shouldFlag = failureCount >= DEAD_SOURCE_THRESHOLD;

  await env.DB.prepare(
    `UPDATE sources
     SET consecutive_failures = ?, last_error = ?, last_error_at = ?,
         flagged_dead = ?, active = ?
     WHERE id = ?`
  )
    .bind(
      failureCount,
      errorMessage.slice(0, 500),
      now,
      shouldFlag ? 1 : 0,
      shouldFlag ? 0 : 1,
      sourceId
    )
    .run();

  return { newlyFlagged: shouldFlag, failureCount };
}

async function recordSourceSuccess(env: Env, sourceId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE sources
     SET consecutive_failures = 0, last_error = NULL, last_error_at = NULL, flagged_dead = 0
     WHERE id = ?`
  )
    .bind(sourceId)
    .run();
}

async function runScheduledCrawl(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, url, category, crawl_frequency, last_crawled_at
     FROM sources WHERE active = 1`
  ).all<{
    id: number;
    url: string;
    category: string;
    crawl_frequency: string;
    last_crawled_at: string | null;
  }>();

  const newlyFlagged: { id: number; category: string }[] = [];

  for (const source of results) {
    if (!isDue(source)) continue;

    try {
      const fetched = await fetchAndStore(env, source.id, source.url);
      if (!fetched.ok) {
        const { newlyFlagged: flagged } = await recordSourceFailure(
          env,
          source.id,
          `fetch returned non-OK status`
        );
        if (flagged) newlyFlagged.push({ id: source.id, category: source.category });
        console.error(`[cron] source ${source.id} fetch returned non-OK status`);
        continue;
      }

      const raw = await env.DB.prepare(
        `SELECT raw_text FROM raw_pages WHERE source_id = ? ORDER BY fetched_at DESC LIMIT 1`
      )
        .bind(source.id)
        .first<{ raw_text: string }>();

      if (!raw) continue;

      const result = await extractAndMatch(env, source.id, raw.raw_text);
      await recordSourceSuccess(env, source.id);
      console.log(
        `[cron] source ${source.id} (${source.category}): inserted=${result.inserted} skipped=${result.skipped}`
      );
    } catch (err) {
      const message = (err as Error).message;
      const { newlyFlagged: flagged } = await recordSourceFailure(env, source.id, message);
      if (flagged) newlyFlagged.push({ id: source.id, category: source.category });
      console.error(`[cron] source ${source.id} failed: ${message}`);
      // Intentionally swallow -- one bad source shouldn't stop the rest of
      // the run. After DEAD_SOURCE_THRESHOLD consecutive failures the source
      // is auto-deactivated by recordSourceFailure, so this stops recurring.
    }
  }

  try {
    const digestResult = await sendDigest(env, newlyFlagged);
    console.log(`[digest] sent=${digestResult.sent}`);
  } catch (err) {
    console.error(`[digest] failed: ${(err as Error).message}`);
  }
}

interface DigestRow {
  id: number;
  title: string;
  organization: string;
  category: string;
  country: string | null;
  deadline: string | null;
  salary: string | null;
  funding_amount: string | null;
  match_score: number | null;
  eligibility_status: string | null;
  application_link: string | null;
}

function renderDigestHtml(
  rows: DigestRow[],
  newlyFlagged: { id: number; category: string }[]
): string {
  const items = rows
    .map((r) => {
      const meta = [r.category, r.country, r.deadline ? `deadline ${r.deadline}` : null]
        .filter(Boolean)
        .join(" · ");
      const money = r.salary || r.funding_amount || "";
      const link = r.application_link
        ? `<a href="${r.application_link}">Apply</a>`
        : "";
      return `<li>
        <strong>${r.title}</strong> — ${r.organization}<br/>
        ${meta}${money ? " · " + money : ""}<br/>
        Match: ${r.match_score ?? "?"} (${r.eligibility_status ?? "unknown"}) ${link}
      </li>`;
    })
    .join("\n");

  const flaggedSection =
    newlyFlagged.length > 0
      ? `<hr/><p><strong>⚠ ${newlyFlagged.length} source${newlyFlagged.length === 1 ? "" : "s"} just deactivated</strong> after ${DEAD_SOURCE_THRESHOLD} consecutive failures: ${newlyFlagged
          .map((s) => `#${s.id} (${s.category})`)
          .join(", ")}. Check /dead-sources for details.</p>`
      : "";

  return `<h2>Opportunity Radar — ${rows.length} new match${rows.length === 1 ? "" : "es"}</h2><ul>${items}</ul>${flaggedSection}`;
}

async function sendDigest(
  env: Env,
  newlyFlagged: { id: number; category: string }[] = []
): Promise<{ sent: number }> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, organization, category, country, deadline, salary,
            funding_amount, match_score, eligibility_status, application_link
     FROM opportunities
     WHERE emailed_at IS NULL
       AND match_score >= ?
       AND (scam_risk IS NULL OR scam_risk = 'low')
     ORDER BY match_score DESC`
  )
    .bind(DIGEST_MIN_SCORE)
    .all<DigestRow>();

  if (results.length === 0 && newlyFlagged.length === 0) {
    console.log("[digest] no new matches and no newly flagged sources, skipping send");
    return { sent: 0 };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.DIGEST_FROM_EMAIL,
      to: env.DIGEST_TO_EMAIL,
      subject:
        results.length > 0
          ? `Opportunity Radar: ${results.length} new match${results.length === 1 ? "" : "es"}`
          : `Opportunity Radar: ${newlyFlagged.length} source${newlyFlagged.length === 1 ? "" : "s"} deactivated`,
      html: renderDigestHtml(results, newlyFlagged),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }

  const now = new Date().toISOString();
  for (const r of results) {
    await env.DB.prepare(`UPDATE opportunities SET emailed_at = ? WHERE id = ?`)
      .bind(now, r.id)
      .run();
  }

  return { sent: results.length };
}

// 2C/2D: dashboard shell + status actions. Served directly from the Worker
// (no separate Pages build/bundle step) since deployment here is paste-into-
// Quick-Edit, not a build pipeline. Plain HTML/CSS/JS, no dependencies.
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Opportunity Radar</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0B1220;
    --panel: #121B2E;
    --panel-2: #16223A;
    --border: #223250;
    --text: #E8ECF3;
    --muted: #8592A6;
    --accent: #3ED598;
    --accent-dim: #245C48;
    --warn: #E8A23D;
    --danger: #E85D5D;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .sweep {
    position: relative;
    width: 22px; height: 22px;
    border-radius: 50%;
    border: 1.5px solid var(--accent-dim);
    flex-shrink: 0;
  }
  .sweep::before {
    content: "";
    position: absolute;
    top: 50%; left: 50%;
    width: 50%; height: 1.5px;
    background: linear-gradient(90deg, var(--accent), transparent);
    transform-origin: left center;
    animation: sweep 2.4s linear infinite;
  }
  @keyframes sweep { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .sweep::before { animation: none; } }
  h1 {
    font-family: "Space Grotesk", sans-serif;
    font-size: 20px;
    font-weight: 700;
    margin: 0;
    letter-spacing: -0.01em;
  }
  #meta { color: var(--muted); font-size: 12.5px; font-family: "IBM Plex Mono", monospace; margin-left: auto; }
  button.ghost, #refresh {
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 7px 12px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
  }
  button.ghost:hover, #refresh:hover { border-color: var(--accent-dim); }
  .toolbar {
    display: flex;
    gap: 8px;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    align-items: center;
  }
  .tab {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 12.5px;
    cursor: pointer;
  }
  .tab.active { color: var(--bg); background: var(--accent); border-color: var(--accent); font-weight: 600; }
  select {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12.5px;
  }
  main { padding: 0 24px 40px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 900px; }
  th {
    text-align: left;
    padding: 10px 10px;
    color: var(--muted);
    font-weight: 500;
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    white-space: nowrap;
  }
  th.sortable:hover { color: var(--text); }
  th .arrow { opacity: 0.5; font-size: 10px; margin-left: 3px; }
  td { padding: 11px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr.dismissed { opacity: 0.45; }
  .title-cell a { color: var(--text); text-decoration: none; font-weight: 600; }
  .title-cell a:hover { color: var(--accent); }
  .org { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .mono { font-family: "IBM Plex Mono", monospace; }
  .score { font-family: "IBM Plex Mono", monospace; font-weight: 600; font-size: 14px; }
  .score.high { color: var(--accent); }
  .score.mid { color: var(--warn); }
  .score.low { color: var(--muted); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-family: "IBM Plex Mono", monospace; }
  .badge.low { background: var(--accent-dim); color: var(--accent); }
  .badge.medium { background: #4A3B1B; color: var(--warn); }
  .badge.high { background: #4A2222; color: var(--danger); }
  .cat { color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.03em; }
  .actions { display: flex; gap: 5px; flex-wrap: nowrap; }
  .actions button {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 4px 8px;
    border-radius: 5px;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }
  .actions button:hover { color: var(--text); border-color: var(--accent-dim); }
  .actions button.current { color: var(--bg); background: var(--accent); border-color: var(--accent); font-weight: 600; }
  #empty { padding: 60px 24px; text-align: center; color: var(--muted); }
  #loading { padding: 40px 24px; color: var(--muted); font-family: "IBM Plex Mono", monospace; font-size: 13px; }
</style>
</head>
<body>
<header>
  <div class="sweep"></div>
  <h1>Opportunity Radar</h1>
  <button id="refresh">Refresh</button>
  <span id="meta"></span>
</header>

<div class="toolbar" id="statusTabs">
  <button class="tab active" data-status="all">All</button>
  <button class="tab" data-status="new">New</button>
  <button class="tab" data-status="saved">Saved</button>
  <button class="tab" data-status="applied">Applied</button>
  <button class="tab" data-status="dismissed">Dismissed</button>
  <select id="categoryFilter">
    <option value="all">All categories</option>
  </select>
  <select id="countryFilter">
    <option value="all">All countries</option>
  </select>
  <button class="tab" id="entryToggle">Entry-level / GT only</button>
  <select id="riskFilter">
    <option value="low">Clean only (hide medium + high risk)</option>
    <option value="hide_high">Hide high-risk only</option>
    <option value="all">All risk levels</option>
  </select>
</div>

<main>
  <div id="loading">Scanning…</div>
  <table id="table" style="display:none">
    <thead>
      <tr>
        <th class="sortable" data-sort="match_score">Match <span class="arrow"></span></th>
        <th>Opportunity</th>
        <th class="cat">Category</th>
        <th>Country</th>
        <th class="sortable" data-sort="deadline">Deadline <span class="arrow"></span></th>
        <th>Money</th>
        <th>Risk</th>
        <th>Status</th>
        <th></th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="empty" style="display:none">No opportunities match this filter.</div>
</main>

<script>
let allRows = [];
let sortKey = "match_score";
let sortDir = "desc";
let statusFilter = "all";
let categoryFilter = "all";
let countryFilter = "nigeria_remote"; // default focus; "all" or "nigeria_remote" or an exact country
let entryOnly = true; // default focus: entry-level / GT only
let riskFilter = "low"; // default focus: show only clean listings; user can loosen this anytime

const ENTRY_LEVEL_RE = /graduate trainee|\bgt\b|entry[\s-]?level|\bjunior\b|\btrainee\b|\binternship\b|\bintern\b|\bnysc\b|fresh graduate|new grad/i;

function isRemote(r) {
  const country = (r.country || "").toLowerCase();
  const title = (r.title || "").toLowerCase();
  return !country || country.includes("remote") || country.includes("anywhere") ||
    country.includes("not specified") || country.includes("worldwide") || title.includes("remote");
}

function isNigeriaOrRemote(r) {
  const country = (r.country || "").toLowerCase();
  return country.includes("nigeria") || isRemote(r);
}

async function load() {
  document.getElementById("loading").style.display = "block";
  document.getElementById("table").style.display = "none";
  const res = await fetch("/opportunities?include_high_risk=1");
  allRows = await res.json();
  populateCategoryFilter();
  populateCountryFilter();
  render();
  document.getElementById("meta").textContent = allRows.length + " tracked · updated " + new Date().toLocaleTimeString();
}

function populateCategoryFilter() {
  const sel = document.getElementById("categoryFilter");
  const current = sel.value;
  const cats = Array.from(new Set(allRows.map(r => r.category).filter(Boolean))).sort();
  sel.innerHTML = '<option value="all">All categories</option>' +
    cats.map(c => '<option value="' + c + '">' + c + '</option>').join("");
  sel.value = cats.includes(current) ? current : "all";
}

function populateCountryFilter() {
  const sel = document.getElementById("countryFilter");
  const countries = Array.from(new Set(allRows.map(r => r.country).filter(Boolean))).sort();
  sel.innerHTML = '<option value="all">All countries</option>' +
    '<option value="nigeria_remote">Nigeria + Remote</option>' +
    countries.map(c => '<option value="' + c + '">' + c + '</option>').join("");
  sel.value = countryFilter;
}

function scoreClass(s) {
  if (s == null) return "low";
  if (s >= 70) return "high";
  if (s >= 40) return "mid";
  return "low";
}

function fmtMoney(r) {
  return r.salary || r.funding_amount || "—";
}

function fmtDeadline(d) {
  if (!d || d === "unknown") return "—";
  return d;
}

function render() {
  let rows = allRows.slice();

  if (statusFilter !== "all") rows = rows.filter(r => (r.status || "new") === statusFilter);
  if (categoryFilter !== "all") rows = rows.filter(r => r.category === categoryFilter);
  if (countryFilter === "nigeria_remote") rows = rows.filter(isNigeriaOrRemote);
  else if (countryFilter !== "all") rows = rows.filter(r => r.country === countryFilter);
  if (entryOnly) rows = rows.filter(r => ENTRY_LEVEL_RE.test(r.title || ""));
  if (riskFilter === "hide_high") rows = rows.filter(r => r.scam_risk !== "high");
  if (riskFilter === "low") rows = rows.filter(r => (r.scam_risk || "low") === "low");

  rows.sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (sortKey === "deadline") {
      av = av && av !== "unknown" ? av : "9999-99-99";
      bv = bv && bv !== "unknown" ? bv : "9999-99-99";
    } else {
      av = av == null ? -1 : av;
      bv = bv == null ? -1 : bv;
    }
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  document.querySelectorAll("th .arrow").forEach(a => a.textContent = "");
  const activeTh = document.querySelector('th[data-sort="' + sortKey + '"] .arrow');
  if (activeTh) activeTh.textContent = sortDir === "asc" ? "▲" : "▼";

  const tbody = document.getElementById("rows");
  const table = document.getElementById("table");
  const empty = document.getElementById("empty");

  if (rows.length === 0) {
    table.style.display = "none";
    empty.style.display = "block";
    document.getElementById("loading").style.display = "none";
    return;
  }

  empty.style.display = "none";
  table.style.display = "table";
  document.getElementById("loading").style.display = "none";

  tbody.innerHTML = rows.map(r => {
    const status = r.status || "new";
    const riskReasons = (() => { try { return JSON.parse(r.scam_reasons || "[]"); } catch { return []; } })();
    const link = r.application_link
      ? '<a href="' + r.application_link + '" target="_blank" rel="noopener">' + r.title + '</a>'
      : r.title;
    return '<tr class="' + (status === "dismissed" ? "dismissed" : "") + '">' +
      '<td><span class="score ' + scoreClass(r.match_score) + '">' + (r.match_score ?? "—") + '</span></td>' +
      '<td class="title-cell">' + link + '<div class="org">' + (r.organization || "") + '</div></td>' +
      '<td class="cat">' + (r.category || "") + '</td>' +
      '<td>' + (r.country || "—") + '</td>' +
      '<td class="mono">' + fmtDeadline(r.deadline) + '</td>' +
      '<td class="mono">' + fmtMoney(r) + '</td>' +
      '<td><span class="badge ' + (r.scam_risk || "low") + '" title="' + riskReasons.join(", ").replace(/"/g, "&quot;") + '">' + (r.scam_risk || "low") + '</span></td>' +
      '<td class="mono">' + status + '</td>' +
      '<td class="actions">' +
        actionBtn(r.id, "saved", status, "Save") +
        actionBtn(r.id, "applied", status, "Applied") +
        actionBtn(r.id, "dismissed", status, "Dismiss") +
      '</td>' +
    '</tr>';
  }).join("");
}

function actionBtn(id, targetStatus, currentStatus, label) {
  const cls = currentStatus === targetStatus ? "current" : "";
  return '<button class="' + cls + '" onclick="setStatus(' + id + ', \\'' + targetStatus + '\\')">' + label + '</button>';
}

async function setStatus(id, status) {
  const row = allRows.find(r => r.id === id);
  const newStatus = row && row.status === status ? "new" : status; // click again to undo
  await fetch("/update-status?id=" + id + "&status=" + newStatus);
  if (row) row.status = newStatus;
  render();
}

document.querySelectorAll(".tab[data-status]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab[data-status]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    statusFilter = btn.dataset.status;
    render();
  });
});

document.getElementById("countryFilter").addEventListener("change", e => {
  countryFilter = e.target.value;
  render();
});

const entryToggleBtn = document.getElementById("entryToggle");
entryToggleBtn.classList.toggle("active", entryOnly);
entryToggleBtn.addEventListener("click", () => {
  entryOnly = !entryOnly;
  entryToggleBtn.classList.toggle("active", entryOnly);
  render();
});

document.getElementById("riskFilter").value = riskFilter;

document.getElementById("categoryFilter").addEventListener("change", e => {
  categoryFilter = e.target.value;
  render();
});
document.getElementById("riskFilter").addEventListener("change", e => {
  riskFilter = e.target.value;
  render();
});
document.querySelectorAll("th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = key; sortDir = key === "deadline" ? "asc" : "desc"; }
    render();
  });
});
document.getElementById("refresh").addEventListener("click", load);

load();
</script>
</body>
</html>`;

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runScheduledCrawl(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/fetch") {
      const sourceId = Number(url.searchParams.get("source_id"));
      if (!sourceId) {
        return new Response("Missing or invalid source_id", { status: 400 });
      }

      const source = await env.DB.prepare(
        `SELECT id, url FROM sources WHERE id = ?`
      )
        .bind(sourceId)
        .first<{ id: number; url: string }>();

      if (!source) {
        return new Response(`No source with id ${sourceId}`, { status: 404 });
      }

      try {
        const result = await fetchAndStore(env, source.id, source.url);
        return new Response(JSON.stringify(result, null, 2), {
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        return new Response(`Fetch failed: ${(err as Error).message}`, {
          status: 502,
        });
      }
    }

    if (url.pathname === "/sources") {
      const { results } = await env.DB.prepare(
        `SELECT id, name, url, category, active, last_crawled_at,
                consecutive_failures, flagged_dead
         FROM sources`
      ).all();
      return new Response(JSON.stringify(results, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/raw") {
      const sourceId = Number(url.searchParams.get("source_id"));
      const { results } = await env.DB.prepare(
        `SELECT id, url, fetched_at, length(raw_text) as len
         FROM raw_pages WHERE source_id = ? ORDER BY fetched_at DESC`
      )
        .bind(sourceId)
        .all();
      return new Response(JSON.stringify(results, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/raw-text") {
      const sourceId = Number(url.searchParams.get("source_id"));
      if (!sourceId) {
        return new Response("Missing or invalid source_id", { status: 400 });
      }
      const row = await env.DB.prepare(
        `SELECT raw_text, fetched_at FROM raw_pages
         WHERE source_id = ? ORDER BY fetched_at DESC LIMIT 1`
      )
        .bind(sourceId)
        .first<{ raw_text: string; fetched_at: string }>();

      if (!row) {
        return new Response(`No raw_pages row for source_id ${sourceId}`, {
          status: 404,
        });
      }

      return new Response(
        `Fetched at: ${row.fetched_at}\n\n${row.raw_text}`,
        { headers: { "content-type": "text/plain" } }
      );
    }

    if (url.pathname === "/extract") {
      const sourceId = Number(url.searchParams.get("source_id"));
      if (!sourceId) {
        return new Response("Missing or invalid source_id", { status: 400 });
      }

      const row = await env.DB.prepare(
        `SELECT raw_text FROM raw_pages WHERE source_id = ? ORDER BY fetched_at DESC LIMIT 1`
      )
        .bind(sourceId)
        .first<{ raw_text: string }>();

      if (!row) {
        return new Response(
          `No raw_pages row for source_id ${sourceId}. Run /fetch?source_id=${sourceId} first.`,
          { status: 404 }
        );
      }

      try {
        const result = await extractAndMatch(env, sourceId, row.raw_text);
        return new Response(JSON.stringify(result, null, 2), {
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        return new Response(`Extraction failed: ${(err as Error).message}`, {
          status: 502,
        });
      }
    }

    if (url.pathname === "/run-cron") {
      // Manual trigger for testing the scheduled crawl logic without
      // waiting for the actual Cron Trigger to fire. Same isDue() +
      // per-source error handling as the real scheduled() handler.
      await runScheduledCrawl(env);
      return new Response(
        "Cron logic ran manually. Check /sources for updated last_crawled_at, " +
          "and /opportunities for new rows. Check the Logs tab for [cron] entries.",
        { headers: { "content-type": "text/plain" } }
      );
    }

    if (url.pathname === "/send-digest") {
      // Manual trigger for testing the digest email without waiting for
      // the cron. Uses the same emailed_at bookkeeping as the real run --
      // rows sent here won't be re-sent by the actual cron later.
      try {
        const result = await sendDigest(env);
        return new Response(JSON.stringify(result, null, 2), {
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        return new Response(`Digest send failed: ${(err as Error).message}`, {
          status: 502,
        });
      }
    }

    if (url.pathname === "/dead-sources") {
      const { results } = await env.DB.prepare(
        `SELECT id, name, url, category, consecutive_failures, last_error, last_error_at
         FROM sources WHERE flagged_dead = 1`
      ).all();
      return new Response(JSON.stringify(results, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/reactivate-source") {
      // After fixing a broken source URL, use this to clear the dead flag
      // and let the cron pick it up again on the next due cycle.
      const sourceId = Number(url.searchParams.get("source_id"));
      if (!sourceId) {
        return new Response("Missing or invalid source_id", { status: 400 });
      }
      await env.DB.prepare(
        `UPDATE sources
         SET active = 1, flagged_dead = 0, consecutive_failures = 0,
             last_error = NULL, last_error_at = NULL
         WHERE id = ?`
      )
        .bind(sourceId)
        .run();
      return new Response(`Source ${sourceId} reactivated.`, {
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.pathname === "/opportunities") {
      const includeHighRisk = url.searchParams.get("include_high_risk") === "1";
      const { results } = await env.DB.prepare(
        `SELECT id, title, organization, category, country, deadline, salary, funding_amount,
                match_score, eligibility_status, scam_risk, scam_reasons, status, application_link
         FROM opportunities
         ${includeHighRisk ? "" : "WHERE scam_risk IS NULL OR scam_risk != 'high'"}
         ORDER BY match_score DESC, deadline ASC`
      ).all();
      return new Response(JSON.stringify(results, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/update-status") {
      // 2D: mark an opportunity saved / applied / dismissed (or back to new).
      const id = Number(url.searchParams.get("id"));
      const status = url.searchParams.get("status");
      const validStatuses = ["new", "saved", "applied", "dismissed"];

      if (!id) {
        return new Response("Missing or invalid id", { status: 400 });
      }
      if (!status || !validStatuses.includes(status)) {
        return new Response(
          `Missing or invalid status. Must be one of: ${validStatuses.join(", ")}`,
          { status: 400 }
        );
      }

      const result = await env.DB.prepare(
        `UPDATE opportunities SET status = ? WHERE id = ?`
      )
        .bind(status, id)
        .run();

      if (result.meta.changes === 0) {
        return new Response(`No opportunity with id ${id}`, { status: 404 });
      }

      return new Response(JSON.stringify({ id, status }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/dashboard") {
      return new Response(DASHBOARD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response(
      "opportunity-radar Worker\n\nRoutes:\n  GET /sources\n  GET /fetch?source_id=N\n  GET /raw?source_id=N\n  GET /raw-text?source_id=N\n  GET /extract?source_id=N\n  GET /opportunities\n  GET /update-status?id=N&status=saved|applied|dismissed|new\n  GET /dashboard\n  GET /run-cron\n  GET /send-digest\n  GET /dead-sources\n  GET /reactivate-source?source_id=N\n",
      { headers: { "content-type": "text/plain" } }
    );
  },
};
