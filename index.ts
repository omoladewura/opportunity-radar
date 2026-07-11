export interface Env {
  DB: D1Database;
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

    return new Response(
      "opportunity-radar Worker\n\nRoutes:\n  GET /sources\n  GET /fetch?source_id=N\n  GET /raw?source_id=N\n",
      { headers: { "content-type": "text/plain" } }
    );
  },
};
