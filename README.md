# Premier League Transfer Market Value Predictor

[![Python](https://img.shields.io/badge/python-3.10%20%7C%203.11%20%7C%203.12-blue)](https://www.python.org/)

[![Tests](https://img.shields.io/badge/tests-pytest-brightgreen)](tests/)

Full-stack ML app that estimates Premier League players' transfer market values from on-pitch output and compares predicted vs actual Transfermarkt valuations. Vanilla JS frontend served directly by a FastAPI backend; shared ML connector in `main.py`.


---

## Table of Contents

- [Overview](#overview)

- [Architecture docs](#architecture-docs)

- [Project structure](#project-structure)

- [Backend roles](#backend-roles)

- [Frontend](#frontend)

- [API](#api)

- [Installation](#installation)

- [Running the pipeline](#running-the-pipeline)

- [Running the web app](#running-the-web-app)

- [ML approach](#ml-approach)

- [Tests](#tests)

- [Limitations](#limitations)


---

## Overview

Transfer valuations are swayed by hype and media narratives. This project learns a transparent statistical baseline from historical player-season output (minutes, appearances, goals, assists, per-90 rates, position) paired with Transfermarkt valuations, then serves it through a searchable web UI with leaderboards, profiles, photos, club badges, and up-to-5-player actual-vs-predicted charts.

Key capabilities:

- **FPL harvesting:** current-season roster, stats, and official photos via the Fantasy Premier League API, with per-URL headshot validation (missing photos stored as `null`, never guessed) (`collect_data.py`).

- **Entity resolution:** FPL ↔ Transfermarkt name matching (Unicode normalisation, token-subset fallback, peak-value tie-break) with overall-latest valuation fallback; currently 593 matched / 74 unmatched (`build_market_values.py`).

- **Scaled Poisson regression:** `TransformedTargetRegressor(÷1e6/×1e6)` around an ordinal-encoded `HistGradientBoostingRegressor` pipeline, evaluated on a seeded 80/20 split (`train_model.py`).

- **Web UI + API:** searchable rankings, morphing profile dialogs, photo lightbox, dock navigation, light/dark themes, and up-to-5-player actual-vs-predicted charts (`static/` + `app.py`), with `main.py` as the shared ML connector library.


---

## Architecture docs

- **[architecture.md](architecture.md)** — full-stack data journey, component roles, request flow.

- **[prd.md](prd.md)** — product requirements: API contract, frontend behaviour, run instructions, known gaps.

- **[production.md](production.md)** — future MLOps/serving blueprint (aspirational, not the current local setup).


---

## Project structure

```text
.
├── app.py                        # FastAPI backend + static file server (serves static/, exposes /api/*)

├── main.py                       # ML connector library (feature engineering, load_data, predict_player)

├── collect_data.py               # Pipeline step 1: harvest FPL rosters/stats/photos

├── build_market_values.py        # Pipeline step 2: entity matching + GBP valuations

├── train_model.py                # Pipeline step 3: train + save model to models/

├── diagnose_prediction.py        # Single-player prediction diagnostic

├── static/
   ├── index.html                # UI layout (search, marquee, leaderboard, profile dialog, comparison, dock)

   ├── app.js                    # UI logic (theme system, morph dialog, search debounce, leaderboard paging, Chart.js compare)

   └── style.css                 # Olive/sage light + dark themes (data-theme variables)

├── data/raw/                     # seasonal_player_stats.csv, player_market_values.csv

├── models/                       # transfer_value_model.joblib (+ .pkl copy), model_metadata.json, training_data.csv

├── opencode.json / .opencode/    # Orchestrator agent config (Research → Build → Test pipeline)

├── src/                          # Modular packages (data_collection, preprocessing, features, modeling, prediction, visualization, utils)

├── tests/test_basic.py

├── prd.md / architecture.md / production.md

├── requirements.txt

└── transfermarkt-datasets.duckdb # Local Transfermarkt source (git-ignored)
```


---

## Backend roles

| File | Role |

| :--- | :--- |

| `app.py` | FastAPI backend **and** frontend host. Loads `DATASET` + `MODEL` on startup via `main`, serves `/api/*`, mounts `/static`, returns `static/index.html` at `/`. |

| `main.py` | Shared ML connector (no CLI). Season helpers, `engineer_features` (per-90 rates), `load_data` (stats ⋈ market values), `get_valid_completed_records`, `predict_player`. Imported by `app.py`, `train_model.py`, `diagnose_prediction.py`. |

| `collect_data.py` | Current-season FPL bootstrap → `data/raw/seasonal_player_stats.csv`. Builds photo URLs from the FPL `code` identifier and nulls the ones the PL CDN doesn't host. |

| `build_market_values.py` | Token-subset identity resolution against DuckDB (exact-season valuation match, overall-latest fallback) → `data/raw/player_market_values.csv`. |

| `train_model.py` | Seeded 80/20-split training; saves `models/transfer_value_model.joblib` **and** a `.pkl` copy, plus full `model_metadata.json` and a `training_data.csv` snapshot. |


---

## Frontend

No build step, no framework — openable via the backend only (API calls are same-origin `/api`).
Static assets are cache-busted (`/static/app.js?v=<mtime>`) so browsers never run stale JS/CSS.

- **Theme:** manual Light/Dark toggle (`data-theme` + `localStorage`, Light default, no-flash pre-paint), olive/sage palette, persisted across refreshes.

- **Search:** debounced autocomplete dropdown (photo, name, team), 2-char minimum.

- **Home:** clickable top-scorers marquee (stat cards) + sortable leaderboard (market value, alphabetical, appearances, minutes, assists, goals; segmented Highest/Lowest tabs; 5 initial rows + "Show 10 More"). Unknown market values sort last and render as `Unknown`, never `£0`.

- **Profile:** morphing dialog expanding from the clicked row (Escape/backdrop close, focus restore, reduced-motion safe), photo with SVG fallback + clickable enlarged lightbox, club badge (Transfermarkt `tmssl` by ID, FPL fallback), season/position meta, APPS/MINS/GOALS/ASSISTS, Actual vs Predicted cards with £/٪ diff, invalid-season warning state. Predictions carry explicit `available`/`unavailable` statuses; comparison only renders when both sides are known.

- **Comparison:** up to 5 players via profile button or in-section Search Player, removable tags, Chart.js actual-vs-predicted line chart (theme-aware colors, nulls render as gaps).

- **Dock:** bottom navigation (Rankings, Search, Compare) with labels and keyboard support.

- **CDN deps:** Lucide icons, Chart.js, Inter font (UI needs network; a blocked icon CDN no longer breaks rendering).


---

## API

| Endpoint | Description |

| :--- | :--- |

| `GET /` | Frontend (`static/index.html`) |

| `GET /api/health` | `{status, data_loaded, model_loaded}` |

| `GET /api/top-scorers` | Top 15 scorers, latest completed season |

| `GET /api/players/search?q=` | ≤10 matches `{player_id, player, team, photo_url}` (`photo_url` is `null` when upstream has no headshot) |

| `GET /api/players/leaderboard?sort_by=&order=&limit=&offset=` | Paginated rankings incl. `predicted_value_gbp`, `actual_market_value_status`, `prediction_status`, `comparison_available`. Unknown actuals stay `null` and sort last. |

| `GET /api/players/{player_id}` | Profile + prediction + valuation statuses; 404 if unknown |


---

## Installation

Prerequisites: Python 3.10–3.12.

```bash
cd "Transfer Value Predicter"

python3 -m venv venv

source venv/bin/activate

pip install --upgrade pip

pip install -r requirements.txt

# Includes fastapi + uvicorn (needed by app.py).
```


---

## Running the pipeline

```bash
python collect_data.py        # → data/raw/seasonal_player_stats.csv

python build_market_values.py # → data/raw/player_market_values.csv

python train_model.py         # → models/transfer_value_model.joblib
```

Raw CSVs are cached under `data/raw/` — no redownload on every run.


---

## Running the web app

```bash
uvicorn app:app --reload

# open http://127.0.0.1:8000/
```

The app loads the saved model once at startup — it never retrains per request.


---

## ML approach

- **Features:** `position`, `team` (ordinal-encoded, unknown-safe) + `age` (from Transfermarkt date of birth), `fpl_minutes`, `goals_p90`, `assists_p90`, `clean_sheets_p90`, `saves_p90`.

- **Target:** `market_value_gbp` trained in millions via `TransformedTargetRegressor` (`main.scale_target` ÷1e6, inverted ×1e6) so the pickled pipeline loads from any entry point; predictions are GBP floats.

- **Split:** seeded random 80/20 split (`random_state=42`) over the single current season in the dataset — deterministic, but not a temporal evaluation.

- **Metrics (current):** MAE £8.1M, RMSE £12.4M, R² 0.44, MdAPE 34.0% — see `models/model_metadata.json`.


---

## Tests

```bash
python -m pytest -q
```

Covers project structure, entrypoints, and `requirements.txt` consistency (`tests/test_basic.py`).


---

## Limitations

1. Single partial season: the model trains and predicts on the in-progress 2026-27 season only, so predictions shift as statistics accumulate and there is no historical generalisation behind them.

2. Box-score only: no contract length, injuries, clauses, commercial appeal, or defensive actions beyond clean sheets/saves. Age is included, but not age trajectory.

3. Identity recall: 74 of 667 players (mostly promoted-club squads) have no Transfermarkt match, hence `Unknown` actual values; 271 of 667 lack upstream headshots.

4. Historical baseline only — not financial or transfer advice.

5. CDN dependency (Lucide, Chart.js, fonts) means the UI degrades offline.
