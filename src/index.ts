export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
}

// Very deliberately dumb HTML->text stripper for Phase 1D. The goal here is
// only to prove the fetch -> strip -> store round trip. If 1E turns up pages
// where nav/footer junk dominates, improve this function (or special-case a
// source) before moving to Phase 2 extraction.
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

// ---- Phase 2A/2B: extraction + matching (job/grad-trainee prioritized) ----

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

  // Defensive: strip stray ```json fences if the model adds them anyway.
  return text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
}

const EXTRACTION_SYSTEM = `You are extracting structured data from a scraped opportunity listing page (scholarship, grant, fellowship, NGO role, job/graduate-trainee posting, or money-making gig). The page may contain multiple listings mixed with navigation or template noise -- ignore the noise, find the real listing(s).

For each listing, also assess scam/fraud risk using these signals (common in fake job/scholarship posts, especially ones surfaced via Google search rather than a verified employer site):
- Any request for upfront payment, "training fee", "processing fee", or bank details before hiring/admission
- Contact only via WhatsApp/Telegram/personal email (gmail/yahoo) with no verifiable company domain or website
- Salary/funding amount unusually high for the role, location, and stated requirements
- Urgency pressure language ("apply within 24 hours", "limited slots", "immediate start, no interview")
- Vague or generic company description with no way to verify the organization exists
- Application process that redirects off-platform to an unrelated or suspicious site
If none of these are present, scam_risk is "low". One or two soft signals -> "medium". Any payment request or clearly fake company -> "high".

Return ONLY valid JSON, no preamble, no markdown fences: an array of objects, each matching this schema:
{
  "title": string,
  "organization": string,
  "category": "scholarship"|"grant"|"fellowship"|"job"|"ngo"|"money",
  "country": string,
  "deadline": string | null,       // ISO date, "rolling", or null if unknown
  "funding_amount": string | null,
  "salary": string | null,
  "eligibility": string,
  "requirements": string[],
  "application_link": string | null,
  "scam_risk": "low"|"medium"|"high",
  "scam_reasons": string[]          // short flags, e.g. ["requests bank details upfront"]. Empty array if low risk.
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

async function extractAndMatch(
  env: Env,
  sourceId: number,
  rawText: string
): Promise<{ inserted: number; skipped: number }> {
  const extractionRaw = await callClaude(
    env,
    EXTRACTION_SYSTEM,
    `Page content:\n${rawText.slice(0, 12000)}`,
    8000
  );

  let listings: ExtractedOpportunity[];
  try {
    listings = JSON.parse(extractionRaw);
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
    `Listings:\n${JSON.stringify(listings)}`
  );

  let scores: { index: number; match_score: number; eligibility_status: string; reason: string }[];
  try {
    scores = JSON.parse(matchRaw);
  } catch {
    throw new Error(`Matching returned non-JSON: ${matchRaw.slice(0, 300)}`);
  }
  const scoreByIndex = new Map(scores.map((s) => [s.index, s]));

  let inserted = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < listings.length; i++) {
    const o = listings[i];
    // Dedup: same title+organization+source already stored.
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Manual trigger for 1D testing: /fetch?source_id=1
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

    // Quick sanity check: list sources
    if (url.pathname === "/sources") {
      const { results } = await env.DB.prepare(
        `SELECT id, name, url, category, active, last_crawled_at FROM sources`
      ).all();
      return new Response(JSON.stringify(results, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    // Inspect what got stored for a source: /raw?source_id=1
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

    // Full stored text for a source, for manual 1E verification:
    // /raw-text?source_id=1 (defaults to most recent fetch for that source)
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

    // Phase 2A/2B: run extraction + matching on the latest raw fetch for a source.
    // /extract?source_id=N
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

    // List extracted opportunities, best matches first: /opportunities
    // Add ?include_high_risk=1 to also show listings flagged high scam risk
    // (hidden by default — they're kept in the DB for your own review, not deleted).
    if (url.pathname === "/opportunities") {
      const includeHighRisk = url.searchParams.get("include_high_risk") === "1";
      const { results } = await env.DB.prepare(
        `SELECT id, title, organization, category, country, deadline, salary,
                match_score, eligibility_status, scam_risk, scam_reasons, status, application_link
         FROM opportunities
         ${includeHighRisk ? "" : "WHERE scam_risk IS NULL OR scam_risk != 'high'"}
         ORDER BY match_score DESC, deadline ASC`
      ).all();
      return new Response(JSON.stringify(results, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      "opportunity-radar Worker\n\nRoutes:\n  GET /sources\n  GET /fetch?source_id=N\n  GET /raw?source_id=N\n  GET /raw-text?source_id=N\n  GET /extract?source_id=N\n  GET /opportunities\n",
      { headers: { "content-type": "text/plain" } }
    );
  },
};
