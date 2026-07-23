# Opportunity Radar — Phase 1 Setup

## 1A. Repo + Cloudflare project scaffold

```bash
mkdir opportunity-radar && cd opportunity-radar
# copy in all files from this bundle
npm install
npx wrangler login
```

Create a new GitHub repo and push:
```bash
git init
git add .
git commit -m "Phase 1 scaffold"
git remote add origin <your-new-repo-url>
git push -u origin main
```

## 1B. D1 database + schema push

Create the D1 instance:
```bash
npm run db:create
```
This prints a `database_id` — copy it into `wrangler.toml`, replacing
`REPLACE_WITH_D1_DATABASE_ID`.

Push the schema, locally first (fast iteration), then remotely:
```bash
npm run db:schema          # local sqlite file wrangler manages for `wrangler dev`
npm run db:schema:remote   # actual Cloudflare D1 instance
```

## 1C. Seed data

`seed.sql` has a placeholder profile row and 10 curated sources. Edit the
profile fields to match your real details, then:
```bash
npm run db:seed
npm run db:seed:remote
```

## 1D. Raw fetch Worker (no AI yet)

Run it locally:
```bash
npm run dev
```
Then in another terminal, hit it against your local D1:
```bash
curl "http://localhost:8787/sources"
curl "http://localhost:8787/fetch?source_id=1"
curl "http://localhost:8787/raw?source_id=1"
```

Try 2-3 different `source_id` values (1, 8, 9 are good — one scholarship
page, two job-board pages) to see how the stripping behaves across
different site structures.

## 1E. Manual verification pass

For each source you tested, check the `raw_text` output:
- Is it mostly page content, or mostly nav/menu/footer text?
- Can you visually spot the deadline, title, eligibility info in the text?

If a source is dominated by junk, options in order of effort:
1. Adjust `stripHtml` in `src/index.ts` (e.g. strip more tag types).
2. Special-case that source (e.g. fetch a different URL — many sites have
   a cleaner print view or API endpoint).
3. Drop the source for now and revisit later — the plan explicitly says
   don't over-engineer scraping for a source that resists it.

Once 2-3 sources look clean, Phase 1 is done — move to Phase 2 (extraction
prompt + dashboard).

## Operational notes (post-launch)

### Frozen source categories (scholarship / fellowship / grant)

As of 2026-07-23, the `scholarship`, `fellowship`, and `grant` category
sources were deliberately frozen (`active = 0`) to cut Claude API costs
while focusing on active job search. This was NOT a bug or a dead-source
flag — it's an intentional pause.

**To reactivate them, run this in the D1 console:**
```sql
UPDATE sources SET active = 1
WHERE category IN ('scholarship', 'fellowship', 'grant');
```

**To freeze them again later:**
```sql
UPDATE sources SET active = 0
WHERE category IN ('scholarship', 'fellowship', 'grant');
```

The `ngo` category (ReliefWeb, Idealist, NGO Jobs in Africa) was deliberately
left active since those are job listings, not scholarships/grants, despite
the category name.

You can always check current state via `GET /sources` — frozen sources show
`"active": 0`.

## Deploying (optional at this stage)

```bash
npm run deploy
```
This publishes the Worker to Cloudflare; the D1 binding in `wrangler.toml`
will point at the remote database once you've filled in the real
`database_id`.
