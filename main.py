# ==========================================================
# main.py
# ==========================================================
from __future__ import annotations
import re, unicodedata, joblib
from datetime import datetime
from pathlib import Path
import numpy as np
import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parent
RAW_DIR = PROJECT_ROOT / "data" / "raw"
MARKET_FILE = RAW_DIR / "player_market_values.csv"
MODEL_FILE = PROJECT_ROOT / "models" / "transfer_value_model.joblib"
MODEL_FILE_PKL = PROJECT_ROOT / "models" / "transfer_value_model.pkl"

# Target scaling helpers live here (importable module) so joblib pickles
# them as `main.scale_target` instead of `__main__.scale_target`,
# which is unloadable from any other entry point (app.py, pytest, -c, ...).
def scale_target(x):
    return x / 1_000_000.0

def inverse_scale_target(x):
    return x * 1_000_000.0

# ADDED 'team' as a critical non-leaking feature for club stature
FEATURE_COLUMNS = ["position", "team", "age", "fpl_minutes", "goals_p90", "assists_p90", "clean_sheets_p90", "saves_p90"]

def normalize_name(value) -> str:
    if not value: return ""
    text = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode("utf-8").lower()
    return " ".join(re.sub(r"[^a-z0-9\s]", " ", text).split())

def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    X = df.copy()
    
    season_years = []
    for s in X["season"]:
        try: season_years.append(int(str(s).split("-")[0]))
        except: season_years.append(datetime.now().year)
    X["season_year"] = season_years
    
    X["dob"] = pd.to_datetime(X.get("date_of_birth"), errors="coerce")
    X["age"] = (X["season_year"] - X["dob"].dt.year).fillna(25.0)
    
    num_cols = ["age", "fpl_minutes", "fpl_goals", "fpl_assists", "fpl_clean_sheets", "fpl_saves"]
    for c in num_cols:
        if c in X.columns: X[c] = pd.to_numeric(X[c], errors="coerce").fillna(0)
            
    fpl_mins_90 = np.maximum(X["fpl_minutes"] / 90.0, 1e-6)
    X["goals_p90"] = X["fpl_goals"] / fpl_mins_90
    X["assists_p90"] = X["fpl_assists"] / fpl_mins_90
    X["clean_sheets_p90"] = X["fpl_clean_sheets"] / fpl_mins_90
    X["saves_p90"] = X["fpl_saves"] / fpl_mins_90
    
    return X

def load_data():
    if not MARKET_FILE.exists(): return pd.DataFrame()
    df = pd.read_csv(MARKET_FILE)
    df["player_id"] = df["player_id"].astype(str).str.strip()
    
    if "val_club_name" in df.columns:
        mask = (df["team"] == "Unknown") & df["val_club_name"].notna()
        df.loc[mask, "team"] = df.loc[mask, "val_club_name"].astype(str)
    return df

def load_model():
    for path in (MODEL_FILE, MODEL_FILE_PKL):
        if path.exists():
            try:
                return joblib.load(path)
            except Exception as e:
                print(f"Failed to load model from {path}: {e}")
    return None

def find_player(df, query):
    q = normalize_name(query)
    df["_norm"] = df["player"].astype(str).map(normalize_name)
    df["_known"] = df["known_name"].astype(str).map(normalize_name)
    exact = df[(df["_norm"] == q) | (df["_known"] == q) | (df["_norm"].str.contains(q))]
    if not exact.empty:
        return exact.copy()
    # Token-subset fallback: all query tokens present in the full name
    # (e.g. "bruno fernandes" -> "bruno borges fernandes").
    q_tokens = set(q.split())
    if q_tokens:
        mask = df["_norm"].map(lambda n: q_tokens.issubset(set(str(n).split())))
        subset = df[mask]
        if not subset.empty:
            return subset.copy()
    return exact.copy()

def get_valid_completed_records(matches: pd.DataFrame) -> pd.DataFrame:
    if matches is None or matches.empty:
        return pd.DataFrame()
    valid = matches.copy()
    valid["market_value_gbp"] = pd.to_numeric(valid["market_value_gbp"], errors="coerce")
    
    season_orders = []
    for s in valid["season"]:
        try: season_orders.append(int(str(s).split("-")[0]))
        except: season_orders.append(0)
    valid["_season_order"] = season_orders
    return valid.sort_values("_season_order", ascending=False)

def predict_player(model, player_record: pd.Series):
    if model is None: return None
    df_rec = pd.DataFrame([player_record])
    features = engineer_features(df_rec)
    X_pred = features[FEATURE_COLUMNS]
    try: 
        val = float(model.predict(X_pred)[0])
        return max(val, 0.0)
    except Exception as e:
        print(f"Prediction error: {e}")
        return None