# ==========================================================
# diagnose_prediction.py
# ==========================================================
import sys
import pandas as pd
import main as app_core

def run_diagnostic(player_name):
    print(f"\n==================================================")
    print(f"PREDICTION DIAGNOSTIC: {player_name.upper()}")
    print(f"==================================================")
    
    df = app_core.load_data()
    matches = app_core.find_player(df, player_name)
    
    if matches.empty:
        print("Player not found in dataset.")
        return

    valid = app_core.get_valid_completed_records(matches)
    if valid.empty:
        print("Player found but has no valid historical seasons with Market Value.")
        return

    record = valid.iloc[0]
    model = app_core.load_model()
    
    print("\n--- BASE METADATA ---")
    print(f"Player:           {record['player']}")
    print(f"Position:         {record['position']}")
    print(f"Season:           {record['season']}")
    print(f"Club:             {record['team']}")
    print(f"Date of Birth:    {record.get('date_of_birth', 'Missing')}")
    print(f"Actual MV:        £{record['market_value_gbp']:,.0f}")

    print("\n--- ENGINEERED FEATURES ---")
    features_df = app_core.engineer_features(pd.DataFrame([record]))
    for col in features_df.columns:
        if col not in ["market_value_gbp", "fpl_price_gbp", "team", "season", "val_club_name"]:
            val = features_df[col].iloc[0]
            if isinstance(val, float): print(f"{col:20s}: {val:.4f}")
            else: print(f"{col:20s}: {val}")

    pred = app_core.predict_player(model, record)
    print("\n--- ML INFERENCE ---")
    print(f"Model Engine:     HistGradientBoostingRegressor (Poisson Loss)")
    print(f"Final Prediction: £{pred:,.0f}")
    
    if record['market_value_gbp'] > 0:
        err = ((pred - record['market_value_gbp']) / record['market_value_gbp']) * 100
        print(f"Percentage Error: {err:+.1f}%")
    print(f"==================================================\n")
    
if __name__ == "__main__":
    player = sys.argv[1] if len(sys.argv) > 1 else "Erling Haaland"
    run_diagnostic(player)