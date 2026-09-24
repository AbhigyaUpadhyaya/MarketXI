# ==========================================================
# collect_data.py
# ==========================================================
import requests
import pandas as pd
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

RAW_DIR = Path(__file__).resolve().parent / "data" / "raw"
RAW_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_FILE = RAW_DIR / "seasonal_player_stats.csv"

FPL_URL = "https://fantasy.premierleague.com/api/bootstrap-static/"

def validate_photo_url(url, timeout=10) -> str | None:
    # The PL CDN answers S3 AccessDenied (403) when a headshot was never
    # uploaded (new signings, youth players). A missing photo must stay
    # null so the UI shows the neutral placeholder — never a wrong image.
    if not url:
        return None
    try:
        resp = requests.head(url, timeout=timeout)
        return url if resp.status_code == 200 else None
    except requests.RequestException:
        return None

def get_current_season() -> str:
    now = datetime.now()
    year = now.year
    return f"{year}-{str(year + 1)[-2:]}" if now.month >= 7 else f"{year - 1}-{str(year)[-2:]}"

def main():
    print("Fetching FPL Data for canonical identity & performance stats...")
    response = requests.get(FPL_URL)
    response.raise_for_status()
    data = response.json()
    
    teams = {t["id"]: t["name"] for t in data["teams"]}
    team_codes = {t["id"]: t["code"] for t in data["teams"]}
    
    current_season = get_current_season()
    records = []
    
    for p in data["elements"]:
        first_name = p.get("first_name", "").replace("firstname", "").strip()
        last_name = p.get("second_name", "").replace("lastname", "").strip()
        full_name = f"{first_name} {last_name}".strip()
        known_name = p.get("web_name", "").strip()
        
        team_id = p.get("team")
        team_code = team_codes.get(team_id)
        team_logo_url = f"https://resources.premierleague.com/premierleague/badges/70/t{team_code}.png" if team_code else None
        
        records.append({
            "player_id": str(p["id"]),
            "player": full_name,
            "known_name": known_name,
            "team": teams.get(team_id, "Unknown"),
            "fpl_team_logo_url": team_logo_url,
            "position": ["Unknown", "Goalkeeper", "Defender", "Midfielder", "Forward"][p.get("element_type", 0)],
            "season": current_season,
            "fpl_minutes": p.get("minutes", 0),
            "fpl_goals": p.get("goals_scored", 0),
            "fpl_assists": p.get("assists", 0),
            "fpl_clean_sheets": p.get("clean_sheets", 0),
            "fpl_goals_conceded": p.get("goals_conceded", 0),
            "fpl_saves": p.get("saves", 0),
            "fpl_price_gbp": p.get("now_cost", 0) * 100000,
            "photo_url": f"https://resources.premierleague.com/premierleague/photos/players/110x140/p{str(p['code'])}.png"
        })
        
    df = pd.DataFrame(records)
    # Validate headshots against the PL CDN (correct FPL `code` identifier);
    # genuinely missing photos become null -> frontend placeholder.
    urls = df["photo_url"].tolist()
    with ThreadPoolExecutor(max_workers=20) as pool:
        df["photo_url"] = list(pool.map(validate_photo_url, urls))
    missing = int(df["photo_url"].isna().sum())
    if missing:
        print(f"Photo check: {missing}/{len(df)} players have no upstream headshot (stored as null).")
    df.to_csv(OUTPUT_FILE, index=False)
    print(f"Saved {len(df)} canonical FPL records to {OUTPUT_FILE}")

if __name__ == "__main__":
    main()