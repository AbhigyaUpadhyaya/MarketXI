# ==========================================================
# build_market_values.py
# ==========================================================
import re
import unicodedata
from pathlib import Path
import duckdb
import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parent
RAW_DIR = PROJECT_ROOT / "data" / "raw"
STATS_FILE = RAW_DIR / "seasonal_player_stats.csv"
OUTPUT_FILE = RAW_DIR / "player_market_values.csv"
DB_FILE = PROJECT_ROOT / "transfermarkt-datasets.duckdb"
EUR_TO_GBP = 0.86

CLUB_MAP = {
    "arsenal": "arsenal fc", "aston villa": "aston villa", "bournemouth": "afc bournemouth",
    "brentford": "brentford fc", "brighton": "brighton & hove albion", "chelsea": "chelsea fc",
    "crystal palace": "crystal palace", "everton": "everton fc", "fulham": "fulham fc",
    "liverpool": "liverpool fc", "luton town": "luton town", "man city": "manchester city",
    "man utd": "manchester united", "newcastle": "newcastle united", "nott'm forest": "nottingham forest",
    "sheff utd": "sheffield united", "spurs": "tottenham hotspur", "west ham": "west ham united",
    "wolves": "wolverhampton wanderers", "burnley": "burnley fc", "ipswich": "ipswich town",
    "leicester": "leicester city", "southampton": "southampton fc"
}

def clean_name(name):
    if pd.isna(name): return ""
    text = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode("utf-8").lower()
    return re.sub(r"[^a-z\s]", "", text)

def get_tokens(name):
    return set(clean_name(name).split())

def main():
    print("Executing Multi-Evidence Identity Resolution...")
    stats = pd.read_csv(STATS_FILE)
    con = duckdb.connect(str(DB_FILE), read_only=True)
    
    tm_players = con.execute("""
        SELECT p.player_id as tm_player_id, p.name as tm_name, 
               c.name as tm_club_name, p.highest_market_value_in_eur, p.date_of_birth
        FROM players p LEFT JOIN clubs c ON p.current_club_id = c.club_id
    """).fetchdf().drop_duplicates("tm_player_id")
    
    valuations = con.execute("""
        SELECT pv.player_id as tm_player_id, pv.date, pv.market_value_in_eur, 
               c.name as val_club_name, c.club_id as val_club_id
        FROM player_valuations pv LEFT JOIN clubs c ON pv.current_club_id = c.club_id
    """).fetchdf()
    con.close()

    tm_players["tokens"] = tm_players["tm_name"].apply(get_tokens)
    tm_players["norm_club"] = tm_players["tm_club_name"].apply(clean_name)
    tm_players["highest_market_value_in_eur"] = tm_players["highest_market_value_in_eur"].fillna(0)
    tm_players = tm_players.sort_values("highest_market_value_in_eur", ascending=False)
    
    unique_fpl = stats.drop_duplicates("player_id").copy()
    identity_map = {}
    match_stats = {"high_confidence": 0, "unmatched": 0}

    for _, row in unique_fpl.iterrows():
        fpl_id = row["player_id"]
        fpl_tokens = get_tokens(row["player"]) | get_tokens(row.get("known_name", ""))
        mapped_tm_club = clean_name(CLUB_MAP.get(str(row["team"]).lower(), str(row["team"]).lower()))
        
        candidates = []
        for _, tm_row in tm_players.iterrows():
            tm_tokens = tm_row["tokens"]
            if not tm_tokens: continue
            
            intersect = fpl_tokens.intersection(tm_tokens)
            club_match = (mapped_tm_club in tm_row["norm_club"]) if tm_row["norm_club"] else False
            
            if len(intersect) >= 2 and club_match:
                candidates.append((tm_row["tm_player_id"], 100, tm_row["highest_market_value_in_eur"]))
            elif (len(intersect) / max(len(tm_tokens), 1) >= 0.5) and club_match:
                candidates.append((tm_row["tm_player_id"], 90, tm_row["highest_market_value_in_eur"]))
            elif len(intersect) >= 2 and tm_row["highest_market_value_in_eur"] > 5000000:
                candidates.append((tm_row["tm_player_id"], 80, tm_row["highest_market_value_in_eur"]))

        if len(candidates) > 0:
            candidates.sort(key=lambda x: (x[1], x[2]), reverse=True)
            identity_map[fpl_id] = candidates[0][0]
            match_stats["high_confidence"] += 1
        else:
            match_stats["unmatched"] += 1

    stats["tm_player_id"] = stats["player_id"].map(identity_map)
    stats = stats.merge(tm_players[["tm_player_id", "date_of_birth"]], on="tm_player_id", how="left")

    def to_season(d):
        return f"{d.year}-{str(d.year+1)[-2:]}" if d.month >= 7 else f"{d.year-1}-{str(d.year)[-2:]}"

    valuations["date"] = pd.to_datetime(valuations["date"])
    valuations["season"] = valuations["date"].apply(to_season)
    val_latest = valuations.sort_values("date").groupby(["tm_player_id", "season"]).tail(1).copy()
    val_latest["market_value_gbp"] = val_latest["market_value_in_eur"] * EUR_TO_GBP

    # Exact season match
    final_df = stats.merge(val_latest[["tm_player_id", "season", "market_value_gbp", "val_club_id", "val_club_name"]], on=["tm_player_id", "season"], how="left")
    
    # Overall fallback for unmatched valuation dates
    val_overall_latest = valuations.sort_values("date").groupby("tm_player_id").tail(1).copy()
    val_overall_latest["market_value_gbp_fallback"] = val_overall_latest["market_value_in_eur"] * EUR_TO_GBP
    
    fallback_map = val_overall_latest.set_index("tm_player_id")["market_value_gbp_fallback"].to_dict()
    fallback_club_id = val_overall_latest.set_index("tm_player_id")["val_club_id"].to_dict()
    fallback_club_name = val_overall_latest.set_index("tm_player_id")["val_club_name"].to_dict()

    missing_mv = final_df["market_value_gbp"].isna() & final_df["tm_player_id"].notna()
    final_df.loc[missing_mv, "market_value_gbp"] = final_df.loc[missing_mv, "tm_player_id"].map(fallback_map)
    
    missing_club = final_df["val_club_id"].isna() & final_df["tm_player_id"].notna()
    final_df.loc[missing_club, "val_club_id"] = final_df.loc[missing_club, "tm_player_id"].map(fallback_club_id)
    final_df.loc[missing_club, "val_club_name"] = final_df.loc[missing_club, "tm_player_id"].map(fallback_club_name)

    final_df["transfermarkt_club_id"] = final_df["val_club_id"]
    final_df.to_csv(OUTPUT_FILE, index=False)
    
    print(f"Data Quality Report:")
    print(f"  - Matched (High Confidence): {match_stats['high_confidence']}")
    print(f"  - Unmatched / Rejected: {match_stats['unmatched']}")

if __name__ == "__main__":
    main()