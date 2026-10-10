# Dusk: Fear-Free Night Navigator

Night walking routes on the **real IIT Guwahati road network** that minimise the *longest continuous concerning
stretch* within a time budget.

- **Geography is real:** OpenStreetMap data for the IITG campus.
- **Street conditions are synthetic:** every baseline condition value comes from a seeded generator.
- **No safety claim:** nothing here establishes real night-time safety.

**Docs:** [Assumptions & acceptance checks](docs/ASSUMPTIONS.md) · [Decisions log](docs/DECISIONS.md) ·
[Cline build log](docs/CLINE_LOG.md) · [How Cline was used](#how-cline-was-used)

---

## Contents
1. [Repository structure](#repository-structure)
2. [Run locally](#run-locally)
3. [Optional features](#optional-features)
4. [Deploy on Render](#deploy-on-render)
5. [How routing works](#how-routing-works)
6. [API endpoints](#api-endpoints)
7. [Real / simulated / not implemented](#real--simulated--not-implemented)
8. [How Cline was used](#how-cline-was-used)
9. [Credits](#credits)

---

## Repository structure

```
.
├── app/                      Backend (Python, FastAPI)
│   ├── main.py               API endpoints and static file serving
│   ├── config.py             Parameters: TAU, R, DELTA, detour factor, risk weights
│   ├── schema.sql            SQLite schema (segments, observations, events, reports, tickets)
│   ├── db.py                 Database connection; applies the schema on startup
│   ├── graph.py              Road segments, adjacency, nearest-node snapping (optional osmnx download)
│   ├── osm_build.py          Builds the walking graph from data/osm_tiles/ (optional rebuild)
│   ├── generate.py           Seeded synthetic condition generator
│   ├── catalog.py            Data-source catalog and the "no institutional dependency" check
│   ├── score.py              Segment risk with unknown-data penalty and staleness
│   ├── conditions.py         Scored network for a departure time; applies verified events
│   ├── route.py              Fastest / Calmest / Balanced router and route metrics
│   ├── reports.py            Report lifecycle: draft, submit, verify, repair, reject, rollback
│   ├── extract.py            Report text extraction: live LLM, cached replay, manual fallback
│   ├── ticket.py             Ticket drafting for verified reports (demo outbox only)
│   ├── ticket_text.py        Ticket schema validation, direct-LLM and template tiers
│   ├── places.py             Campus place search (Nominatim, then stored OSM names)
│   ├── google_places.py      Optional Google Places search source
│   └── agent_node/           Cline SDK ticket agent (Node, zero tools, stdin/stdout)
├── static/                   Frontend (plain HTML/CSS/JS + Leaflet, no build step)
│   ├── index.html            Map page
│   ├── map.js                Map, place search, routing, route cards, exposure ribbons
│   ├── report.js             Segment drawer and report flow
│   ├── style.css             Base styles
│   ├── night.css             Night palette and route-card styles
│   ├── portal.html           Reviewer portal
│   └── provenance.html       Data-source ledger
├── data/
│   ├── osm_tiles/            Raw OpenStreetMap tiles for the campus (10 files)
│   ├── iitg.graphml          Projected walking graph (EPSG:32646)
│   ├── segments.json         ~30 m road segments used by the router
│   ├── scenario_v1.json      Synthetic scenario parameters (seed, zones, noise)
│   ├── demo_pairs.json       Demo routes + measured gate numbers (written by scripts/demo_gate.py)
│   └── iitg_query.overpass   Overpass query kept for reference
├── scripts/
│   └── demo_gate.py          Samples routes, reports gate numbers, writes data/demo_pairs.json
├── tests/                    pytest suite (71 tests)
├── spikes/cline_sdk/         Standalone Cline SDK spike script
├── docs/
│   ├── ASSUMPTIONS.md        Parameters, acceptance checks, demo pairs, measured aggregates
│   ├── DECISIONS.md          Every departure from, or gap filled in, the build spec
│   └── CLINE_LOG.md          Block-by-block build log and SDK spike record
├── requirements.txt          Runtime and test dependencies
├── requirements-osm.txt      Optional: osmnx, only for rebuilding geography
└── render.yaml               Render Blueprint (free web service)
```

- **Not committed:** `data/fnn.db` (created by `python -m app.generate`), `data/outbox/` (demo tickets) and
  `node_modules/`.

---

## Run locally

```bash
pip install -r requirements.txt
python -m app.generate       # seeded synthetic observations into data/fnn.db
uvicorn app.main:app --port 8000
pytest -q
```

- **Map:** http://localhost:8000
  - Choose a demo route, search a place in From / To, or click the map for start and end.
  - Click any road for its per-field drawer and to report a problem.
- **Reviewer portal:** `/portal`
  - Token from `FNN_REVIEWER_TOKEN` (default `demo-reviewer-token`). **Demo auth only.**
- **Provenance:** `/provenance`
  - The dependency ledger. The actual source of every v1 condition value is `synthetic_generator`.
- **Demo gate:** `python scripts/demo_gate.py`
  - Prints concerning share by hour and route-improvement counts, and rewrites `data/demo_pairs.json`.

---

## Optional features

- **Rebuild the geography**
  - `pip install -r requirements-osm.txt`, then `python -m app.osm_build`.
  - Rebuilds `data/iitg.graphml` and `data/segments.json` from the raw tiles in `data/osm_tiles/`.
  - Both outputs are committed, so this is only needed if you change the tiles or the walkability filter.
  - Re-run `python -m app.generate` afterwards.
- **Ticket agent**
  - `cd app/agent_node && npm install` (Node >= 22), plus `ANTHROPIC_API_KEY`.
  - Tickets are then drafted by a Cline SDK agent with zero tools.
  - Without it they fall back to a direct LLM call, then a template. The `drafted_by` field says which path
    produced each ticket.
- **Live report extraction**
  - Set `ANTHROPIC_API_KEY`.
  - Without it, the demo Hinglish sentence uses a cached response shown with a `REPLAY (cached response)` badge;
    any other text falls back to manual categories.
- **Google Places search**
  - Set `GOOGLE_PLACES_API_KEY`. From / To search then uses Google Places first (campus area only), then
    OpenStreetMap.
  - Without it, OpenStreetMap only.

---

## Deploy on Render

- **Setup:** `render.yaml` defines one free-tier web service. In Render: **New → Blueprint**, pick this repo,
  and apply.
- **Commands:**
  - Build: `pip install -r requirements.txt`
  - Start: `python -m app.generate && uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- **Auto-deploy:** every merge to `main` redeploys.
- **Resettable demo: state is restored on every restart.**
  - The free tier has no persistent disk, so the database is regenerated from the committed seed at each boot.
  - Reports, verifications and tickets made on the live site are lost when the service restarts or sleeps
    (after about 15 minutes idle; the first request after that takes ~1 minute).
- **Environment variables:**
  - `FNN_REVIEWER_TOKEN`: generated by Render. Copy it from the service's Environment tab for `/portal`. The
    public default token is not used on the deployed site.
  - `GOOGLE_PLACES_API_KEY`: optional, see above.
  - `ANTHROPIC_API_KEY`: optional. Without it, extraction uses replay/manual and tickets use the template tier.
- **Ticket agent on Render:** the `app/agent_node` tier is not installed by this build, so deployed tickets come
  from the direct LLM call at best.

---

## How routing works

- **Fastest**
  - Dijkstra on walk time.
  - Defines the time budget: B = fastest time × 1.4.
- **Calmest**
  - Product graph over (node, concerning-metres bucket, good-metres bucket); binary search on the bound L, with
    feasibility = minimum-time path within B.
  - L* is an upper bound on the optimum among U-turn-free walks; the bucketing is conservative, so the reported
    longest stretch is never under-stated.
- **Balanced**
  - Minimises total concerning metres under the L* bound and the budget.
  - Best among generated candidates, not exact.
- **Continuity rule**
  - A concerning segment extends the current stretch; it breaks only after 40 m (R) of assessed-good road.
  - Unknown segments are scored pessimistically, count as concerning and never break a stretch.
- **Merged cards:** routes overlapping more than 85% are shown as one card, with the other names in `also`.
- **No calmer route:** when no calmer route fits the budget, the app says so. That is correct behaviour, not a
  failure.

---

## API endpoints

- **Routing and map**
  - `GET /api/health`, `GET /api/config`
  - `GET /api/network?hour=` : every segment with its risk and status
  - `POST /api/route` : route cards, including the longest-run span and distances
  - `GET /api/segment/{id}?hour=` : per-field values, sources and validity for one segment
- **Places and demo**
  - `GET /api/places`, `GET /api/places/search?q=`
  - `GET /api/demo_pairs` (503 if the file is missing)
- **Reports** (public)
  - `POST /api/report/draft`, `POST /api/report/submit`
- **Review** (reviewer token required)
  - `GET /api/review/reports`
  - `POST /api/review/verify`, `/repair`, `/reject`, `/rollback`, `/ticket`
- **Provenance:** `GET /api/provenance`

---

## Real / simulated / not implemented

- **Real**
  - OSM geography for the IITG campus.
  - The route mathematics.
  - The report → authenticated review → expiring event → reroute loop.
- **Simulated**
  - Every baseline condition value (`source = synthetic_generator`), from parameters we chose.
- **Not implemented**
  - Anti-concentration, reporter reputation and outlier detection.
  - Automatic dead-lamp detection; loitering inference (removed permanently).
  - Native telemetry; bus / cab chains.
  - Exact exposure minimisation.
  - Any pilot or authority cooperation.

---

## How Cline was used

- **Full log:** [`docs/CLINE_LOG.md`](docs/CLINE_LOG.md)
- **Spec departures and gaps Cline filled:** [`docs/DECISIONS.md`](docs/DECISIONS.md)

### In the build (block by block, from the log)
- **Block 0:** scaffold, SQL schema (B1), config with the Part H parameters.
- **Block 2:** scoring (C2) and the product-graph router (C3).
  - Gate tests were written first: counterexample, budget, subdivision, unreachable.
- **Block 1:** geography and synthetic data.
  - Overpass / osmnx downloads failed from the sandbox (504s, resets).
  - Cline switched to OSM main API tiles plus its own graph builder, then wrote the seeded narrow-observation
    generator and catalog.
- **Block 4:** report lifecycle.
  - Draft / accepted / verified / fixed / rejected, with rollback.
  - Expiring events, idempotency, live → replay → manual extraction, end-to-end loop test.
- **Block 3:** Leaflet UI, segment drawer, reviewer portal, provenance page.

### Who wrote what
- **Written by Cline**
  - All code in `app/`, `tests/`, `scripts/`, `spikes/` and `app/agent_node/`.
  - The data pipeline and the docs, as recorded in git.
- **Directed or corrected by the team** (Cline implemented each change as instructed)
  - The build spec.
  - Pinning `pyproj`.
  - Measuring the first scenario and requiring its restructuring.
  - Finding that bucket merging makes the Calmest bound an upper bound, not exact, and rewording the claim.
  - Removing the unused `L_CAP_M`.
  - Turning the demo gate's 60% target into a 30% recorded baseline.
  - The "no calmer route is correct behaviour" decision.
  - Re-running the SDK spike with a real key.
- **Frontend (`static/`)**
  - Cline wrote the initial static/ files in Block 3; the team has maintained them by hand since, and Cline was
    instructed not to modify them during the fix round.

### Cline in the product: the ticket agent
- **Trigger:** a reviewer requests a ticket (`POST /api/review/ticket`).
- **How it runs:** `app/ticket.py` runs `app/agent_node/index.mjs` as a subprocess.
  - It is a Cline SDK `Agent` (`@cline/sdk` 0.0.92) with **zero tools**: no shell, filesystem or web access.
  - One JSON object on stdin, one on stdout; the output is validated in Python against a strict schema.
- **`drafted_by` tiers:**
  1. `"cline sdk agent (@cline/sdk 0.0.92)"`: the SDK agent succeeded and its output validated.
  2. `"cline-authored module (SDK integration not run)"`: the agent failed, timed out or returned invalid output,
     so one direct LLM call was made instead.
  3. `"cline-authored module (SDK integration not run); LLM unavailable, deterministic template text"`: both
     failed, so a deterministic English / Hindi template was built from database facts.
- **Never sent anywhere:** every ticket has `delivered: 0` and
  `disclosure: "demo outbox - not delivered to any authority"`.

### Two real findings from the build
- **Routes doubled back.**
  - On the real IITG graph, the optimal product-graph walk often doubled back along an edge to reset its stretch
    counter.
  - Fixed by forbidding same-edge U-turns, plus a relaxation that, when the walk still revisits a node, steps the
    bound up and labels the card "not proven optimal".
- **`agent.run()` does not throw on failure.**
  - It resolves with `status: "failed"`.
  - A first version of the spike read only `outputText` and wrongly reported success. The committed spike checks
    `status` and `error`.

### The SDK spike
- **In the build sandbox:** `@cline/sdk` 0.0.92 (Node >= 22) installed, but the trivial agent call failed with
  "Anthropic API key is missing"; the sandbox has no key.
- **Team re-run:** with a real `ANTHROPIC_API_KEY`, `spikes/cline_sdk/spike.mjs` returned `ok: true`.
  - That pass was observed by the team and cannot be reproduced in the sandbox.
  - Details in [`docs/CLINE_LOG.md`](docs/CLINE_LOG.md).

---

## Credits

- **Parameters and acceptance-check status:** [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md)
- **Every decision that departed from or filled gaps in the build spec:** [`docs/DECISIONS.md`](docs/DECISIONS.md)
- **Geography:** © OpenStreetMap contributors, ODbL.
- **Map tiles:** © CARTO.
