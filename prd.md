# Product Requirements Document — Premier League Transfer Value Predictor (Full-Stack)


## 1. Overview

Full-stack web application that estimates Premier League players' transfer market values from on-pitch output and compares predicted vs actual Transfermarkt valuations.

Users browse rankings, search players, view profiles with photos and club badges, and compare up to 5 players on an actual-vs-predicted chart.


## 2. Architecture (as built)

- **Frontend (`static/`):** vanilla HTML/CSS/JS, no build step, no framework. Assets cache-busted via `?v=<mtime>`.

  `index.html` (navbar + search + theme toggle, top-scorers marquee, leaderboard, morphing profile dialog + photo lightbox, comparison with search popover, dock), `app.js` (theme system with `localStorage`, debounced search, sortable/paginated leaderboard, FLIP dialog, Chart.js comparison up to 5 players), `style.css` (olive/sage `data-theme` variables, responsive + reduced-motion rules).

  CDN-only deps: Lucide icons, Chart.js, Google Fonts. `package.json` is an empty placeholder `{}`.

- **Backend (`app.py`):** FastAPI app that serves the API **and** the frontend via `StaticFiles(directory="static")` plus `GET /` → `static/index.html`.

  CORS open (`allow_origins=["*"]`).

- **ML connector (`main.py`):** shared library, not a CLI.

  Provides `FEATURE_COLUMNS`, `scale_target`/`inverse_scale_target` (÷1e6/×1e6), `engineer_features` (age from DoB + per-90 rates), `load_data`, `load_model` (joblib→pkl fallback), `find_player` (exact + token-subset fallback), `get_valid_completed_records`, `predict_player`.

  Imported by `app.py`, `train_model.py`, `diagnose_prediction.py`.

- **Offline pipeline:** `collect_data.py` (current-season FPL roster + photo validation) → `build_market_values.py` (DuckDB matching with overall-latest fallback, 593/74 split) → `train_model.py` (seeded 80/20 split, `OrdinalEncoder` + Poisson `HistGradientBoostingRegressor` wrapped in `TransformedTargetRegressor(÷1e6/×1e6)`, saves `.joblib` + `.pkl` + metadata + snapshot).

- **Diagnostics:** `diagnose_prediction.py` (single-player lookup via the same `main` helpers).


## 3. API contract (`app.py`)

- `GET /api/health` → `{status, data_loaded, model_loaded}`

- `GET /api/top-scorers` → top 15 scorers of latest completed season (marquee shows 7)

- `GET /api/players/search?q=` → up to 10 matches (min 2 chars), `{player_id, player, team, photo_url}` (`null` when upstream has no headshot)

- `GET /api/players/leaderboard?sort_by=&order=&limit=&offset=` → `{total, offset, limit, players[]}`

  `sort_by` ∈ `market_value | alphabetical | appearances | minutes | assists | goals`; each player includes `predicted_value_gbp`, `has_valid_season`, `actual_market_value_status`, `prediction_status`, `comparison_available`; unknown actuals stay `null` and sort last

- `GET /api/players/{player_id}` → full profile + `predicted_value_gbp` + statuses + `has_valid_season`

  404 if unknown; `has_valid_season=false` with nulls when no season has a market value

- `GET /` → frontend with cache-busted asset URLs; `/static/*` → static assets


## 4. Frontend requirements

- **Theme:** manual Light/Dark toggle (`data-theme`, persisted, Light default, no-flash); olive/sage variables; all surfaces (rows, cards, dialog, dock, chart) follow both themes.

- **Search:** debounced (~300 ms) autocomplete dropdown with photo, name, team; empty state "No player found."

- **Home:** top-scorers marquee (clickable stat cards) + sortable leaderboard (6 sort keys, segmented Highest/Lowest tabs, initial 5 rows, "Show 10 More" pagination, terminal error state, unknowns last as `Unknown`).

- **Profile:** morphing dialog (FLIP from trigger, backdrop/Escape close, focus restore), photo button with enlarged FLIP lightbox (SVG fallback), club badge (`tmssl` by ID, FPL fallback, hidden on error), team/position/season meta, APPS/MINS/GOALS/ASSISTS strip, Actual vs Predicted cards with diff (£ + %, over/underestimated) gated on `comparison_available`, invalid-season warning hides stats/valuation.

- **Comparison:** add up to 5 valid-season players (profile button with morphing label, or in-section Search Player popover with keyboard support), removable tags, Chart.js line chart (theme-aware, null gaps, repaint on theme switch, survives blocked CDN).

- **Dock:** bottom nav (Rankings, Search, Compare) with labels, mobile-safe, content padded clear.

- **Hardening:** cache-busted assets, icon/CDN failures isolated from core rendering, reduced-motion support.


## 5. Data & ML

- **Sources:** FPL API (rosters, per-season stats, photos, FPL prices) + local Transfermarkt DuckDB (`players`, `player_valuations`, `appearances`, `clubs`).

- **Identity resolution:** Unicode normalisation, particle stripping, FPL-tokens ⊆ TM-tokens or ≥60% overlap, highest-peak-value tie-break.

- **Features:** `position`, `team` (ordinal, unknown-safe) + `age`, `fpl_minutes`, `goals_p90`, `assists_p90`, `clean_sheets_p90`, `saves_p90`.

  Target `market_value_gbp` trained in millions (÷1e6, inverted ×1e6); current metrics MAE £8.1M / R² 0.44 on a seeded 80/20 split of the single 2026-27 season (564 rows).

- **Discipline:** cache raw CSVs under `data/raw/`; log data-quality issues rather than silently dropping; unknown market values stay `null` end-to-end (never £0 or fallbacks).


## 6. Run

```bash
python3 -m venv venv && source venv/bin/activate

pip install -r requirements.txt   # includes fastapi + uvicorn for app.py

python collect_data.py && python build_market_values.py && python train_model.py

uvicorn app:app --reload          # open http://127.0.0.1:8000/

python -m pytest -q
```


## 7. Known gaps (observed, not assumed)

- Single partial season (2026-27 only): the 80/20 split is not a temporal evaluation; predictions move as statistics accumulate.

- Identity recall: 74 unmatched + 29 unvalued rows have `Unknown` actuals; 271 players lack upstream headshots (`null` photo, placeholder shown).

- `models/trained_model.pkl` is stale/legacy; `src/*/`, `notebooks/`, `data/processed/` are empty scaffolding.

- `train_model.py` uses Poisson `HistGradientBoostingRegressor`, not the `LinearRegression` named in older briefs (kept deliberately; see git history).

- CDN dependency (Lucide, Chart.js, fonts) means the full UI needs network, though core rendering is isolated from icon/chart failures.


## 8. Non-goals

No auth, no write paths, no retraining from the UI, no framework-based frontend build, no fabricated market values — predictions are statistical baselines, not financial advice.
