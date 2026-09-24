# ==========================================================
# app.py (FastAPI Backend + Static File Server)
# ==========================================================
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
import pandas as pd
import math
import numpy as np
import os
from pathlib import Path

import main as ml_pipeline

PROJECT_ROOT = Path(__file__).resolve().parent

app = FastAPI(title="Transfer Value Predictor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATASET = None
MODEL = None

def clean_nan(val):
    if pd.isna(val) or (isinstance(val, float) and math.isnan(val)):
        return None
    if isinstance(val, (np.integer, np.floating)):
        return val.item()
    return val

def is_valid_gbp(value) -> bool:
    # A market value is only valid if it is a real positive number.
    # Missing/NaN/zero must stay "unknown" — never £0.
    try:
        return value is not None and float(value) > 0
    except (TypeError, ValueError):
        return False

def with_valuation_states(data: dict) -> dict:
    actual = data.get("market_value_gbp")
    predicted = data.get("predicted_value_gbp")
    data["actual_market_value_status"] = "available" if is_valid_gbp(actual) else "unknown"
    data["prediction_status"] = "available" if is_valid_gbp(predicted) else "unavailable"
    # Comparison/error only when BOTH sides are genuine numbers.
    data["comparison_available"] = (
        data["actual_market_value_status"] == "available"
        and data["prediction_status"] == "available"
    )
    return data

def record_to_dict(record: pd.Series) -> dict:
    tm_club_id = record.get("transfermarkt_club_id")
    fpl_logo = clean_nan(record.get("fpl_team_logo_url"))
    
    # Badge must match the *displayed* (current FPL) team. The Transfermarkt
    # club id can be stale after transfers (e.g. Villa id on a Chelsea
    # player), so the FPL badge leads and TM is only a fallback.
    club_logo_url = fpl_logo
    if not club_logo_url and pd.notna(tm_club_id) and str(tm_club_id).strip() != "" and str(tm_club_id).strip().lower() != "nan":
        try:
            club_logo_url = f"https://tmssl.akamaized.net/images/wappen/head/{int(float(tm_club_id))}.png"
        except (ValueError, TypeError):
            club_logo_url = None

    minutes = clean_nan(record.get("total_minutes")) or clean_nan(record.get("fpl_minutes"))
    goals = clean_nan(record.get("total_goals")) if clean_nan(record.get("total_goals")) is not None else clean_nan(record.get("fpl_goals"))
    assists = clean_nan(record.get("total_assists")) if clean_nan(record.get("total_assists")) is not None else clean_nan(record.get("fpl_assists"))
    
    appearances = clean_nan(record.get("total_appearances"))
    if appearances is None and minutes is not None:
        appearances = minutes // 90

    return {
        "player_id": str(record.get("player_id", "")),
        "player": str(record.get("player", "Unknown")),
        "team": str(record.get("team", "Unknown")),
        "position": str(record.get("position", "Unknown")),
        "season": str(record.get("season", "Unknown")),
        "photo_url": clean_nan(record.get("photo_url")) or None,
        "club_logo_url": club_logo_url,
        "total_appearances": appearances,
        "total_minutes": minutes,
        "total_goals": goals,
        "total_assists": assists,
        "market_value_gbp": clean_nan(record.get("market_value_gbp")),
        "fpl_price_gbp": clean_nan(record.get("fpl_price_gbp")),
        "fpl_minutes": clean_nan(record.get("fpl_minutes")),
        "fpl_clean_sheets": clean_nan(record.get("fpl_clean_sheets")),
        "fpl_goals_conceded": clean_nan(record.get("fpl_goals_conceded")),
        "fpl_saves": clean_nan(record.get("fpl_saves"))
    }

@app.on_event("startup")
def startup_event():
    global DATASET, MODEL
    try:
        DATASET = ml_pipeline.load_data()
        MODEL = ml_pipeline.load_model()
        print(f"Backend Ready: Loaded {len(DATASET) if DATASET is not None else 0} records.")
    except Exception as e:
        print(f"Failed to load data/model on startup: {e}")

@app.get("/api/health")
def health_check():
    return {"status": "ok", "data_loaded": DATASET is not None, "model_loaded": MODEL is not None}

@app.get("/api/top-scorers")
def get_top_scorers():
    if DATASET is None: raise HTTPException(status_code=500, detail="Dataset not loaded")
    valid_records = ml_pipeline.get_valid_completed_records(DATASET)
    if valid_records.empty: return []
    latest_season = valid_records.iloc[0]["season"]
    top_scorers = valid_records[valid_records["season"] == latest_season].sort_values("fpl_goals", ascending=False).head(15)
    return [record_to_dict(row) for _, row in top_scorers.iterrows()]

@app.get("/api/players/search")
def search_players(q: str):
    if DATASET is None: raise HTTPException(status_code=500, detail="Dataset not loaded")
    if not q or len(q.strip()) < 2: return []
    matches = ml_pipeline.find_player(DATASET, q)
    if matches.empty: return []
    unique_players = matches.drop_duplicates(subset=["player_id"], keep="first")
    return [{"player_id": str(r["player_id"]), "player": str(r["player"]), "team": str(r["team"]), "photo_url": clean_nan(r["photo_url"])} for _, r in unique_players.head(10).iterrows()]

@app.get("/api/players/leaderboard")
def get_leaderboard(sort_by: str = "market_value", order: str = "desc", limit: int = 5, offset: int = 0):
    if DATASET is None: raise HTTPException(status_code=500, detail="Dataset not loaded")
    valid_records = ml_pipeline.get_valid_completed_records(DATASET)
    if valid_records.empty: return {"total": 0, "offset": offset, "limit": limit, "players": []}
    
    latest_records = valid_records.drop_duplicates(subset=["player_id"], keep="first").copy()
    numeric_cols = {"market_value": "market_value_gbp", "appearances": "total_appearances", "minutes": "fpl_minutes", "assists": "fpl_assists", "goals": "fpl_goals"}
    ascending = (order.lower() == "asc")
    
    if sort_by == "alphabetical":
        latest_records["sort_key"] = latest_records["player"].astype(str).str.lower()
        latest_records = latest_records.sort_values(by="sort_key", ascending=ascending)
    elif sort_by in numeric_cols:
        col = numeric_cols[sort_by]
        # Sort key only: unknown market values sort last, and the payload
        # keeps null (never zero-filled). Stat columns may use 0 (genuine).
        if col == "market_value_gbp":
            latest_records["_sort_key"] = pd.to_numeric(latest_records[col], errors="coerce")
            latest_records = latest_records.sort_values(by="_sort_key", ascending=ascending, na_position="last")
        else:
            latest_records[col] = pd.to_numeric(latest_records[col], errors="coerce").fillna(0)
            latest_records = latest_records.sort_values(by=col, ascending=ascending)
    else:
        latest_records["_sort_key"] = pd.to_numeric(latest_records["market_value_gbp"], errors="coerce")
        latest_records = latest_records.sort_values(by="_sort_key", ascending=ascending, na_position="last")
    
    sliced = latest_records.iloc[offset : offset + limit]
    results = []
    for _, row in sliced.iterrows():
        d = record_to_dict(row)
        d["has_valid_season"] = True
        d["predicted_value_gbp"] = clean_nan(ml_pipeline.predict_player(MODEL, row))
        results.append(with_valuation_states(d))
        
    return {"total": len(latest_records), "offset": offset, "limit": limit, "players": results}

@app.get("/api/players/{player_id}")
def get_player(player_id: str):
    if DATASET is None: raise HTTPException(status_code=500, detail="Dataset not loaded")
    
    player_history = DATASET[DATASET["player_id"].astype(str) == str(player_id)]
    if player_history.empty: raise HTTPException(status_code=404, detail="Player not found")
        
    valid_records = ml_pipeline.get_valid_completed_records(player_history)
    if valid_records.empty:
        data = record_to_dict(player_history.iloc[0])
        data["has_valid_season"] = False
        data["predicted_value_gbp"] = None
        return with_valuation_states(data)
        
    best_record = valid_records.iloc[0]
    data = record_to_dict(best_record)
    data["has_valid_season"] = True
    data["predicted_value_gbp"] = clean_nan(ml_pipeline.predict_player(MODEL, best_record))
    return with_valuation_states(data)

os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

def _asset_version() -> int:
    # Cache-bust frontend assets so browsers never run stale JS/CSS
    # against new HTML (which renders as broken/native controls).
    try:
        paths = [PROJECT_ROOT / "static" / f for f in ("app.js", "style.css", "index.html")]
        return int(max(p.stat().st_mtime for p in paths if p.exists()))
    except OSError:
        return 0

@app.get("/")
def serve_frontend():
    html = (PROJECT_ROOT / "static" / "index.html").read_text(encoding="utf-8")
    v = _asset_version()
    html = html.replace("/static/app.js", f"/static/app.js?v={v}").replace(
        "/static/style.css", f"/static/style.css?v={v}"
    )
    return HTMLResponse(html)