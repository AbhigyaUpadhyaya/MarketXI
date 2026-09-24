# ==========================================================
# train_model.py
# ==========================================================
import numpy as np
import pandas as pd
import joblib
from pathlib import Path
from sklearn.compose import ColumnTransformer, TransformedTargetRegressor
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.preprocessing import OrdinalEncoder
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.model_selection import train_test_split

import main as app_core
from main import scale_target, inverse_scale_target

MODEL_FILE = Path(__file__).resolve().parent / "models" / "transfer_value_model.joblib"
MODEL_FILE_PKL = Path(__file__).resolve().parent / "models" / "transfer_value_model.pkl"
METADATA_FILE = Path(__file__).resolve().parent / "models" / "model_metadata.json"
TRAINING_SNAPSHOT = Path(__file__).resolve().parent / "models" / "training_data.csv"

def median_signed_percentage_error(y_true, y_pred):
    return np.median((y_pred - y_true) / y_true) * 100

def median_absolute_percentage_error(y_true, y_pred):
    return np.median(np.abs((y_true - y_pred) / y_true)) * 100

def main():
    print("Training Scaled Poisson Regression Model...")
    df = app_core.load_data()
    df["market_value_gbp"] = pd.to_numeric(df["market_value_gbp"], errors="coerce")
    df = df[df["market_value_gbp"].notna() & (df["market_value_gbp"] > 0)].copy()
    
    X_full = app_core.engineer_features(df)
    
    cat_features = ["position", "team"]
    
    X = X_full[app_core.FEATURE_COLUMNS]
    y = df["market_value_gbp"]

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    preprocessor = ColumnTransformer([
        ("cat", OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1), cat_features)
    ], remainder="passthrough")
    
    base_model = Pipeline([
        ("pre", preprocessor),
        ("hgb", HistGradientBoostingRegressor(
            loss="poisson", 
            categorical_features=[0, 1], 
            learning_rate=0.05, 
            max_iter=300, 
            min_samples_leaf=15,
            random_state=42
        ))
    ])
    
    # Use top-level named functions instead of local lambdas
    model = TransformedTargetRegressor(
        regressor=base_model, 
        func=scale_target, 
        inverse_func=inverse_scale_target
    )
    
    model.fit(X_train, y_train)
    preds = model.predict(X_test)
    
    print(f"\n--- EVALUATION (TEST SET) ---")
    print(f"MAE:       £{mean_absolute_error(y_test, preds):,.0f}")
    print(f"RMSE:      £{np.sqrt(np.mean((y_test - preds)**2)):,.0f}")
    print(f"R²:        {r2_score(y_test, preds):.2f}")
    print(f"MdAPE:     {median_absolute_percentage_error(y_test, preds):.1f}% (Median Abs Error)")
    print(f"Md. BIAS:  {median_signed_percentage_error(y_test, preds):+.1f}% (Median Signed Bias)")

    MODEL_FILE.parent.mkdir(exist_ok=True)
    joblib.dump(model, MODEL_FILE)
    joblib.dump(model, MODEL_FILE_PKL)

    import json
    mae = float(mean_absolute_error(y_test, preds))
    rmse = float(np.sqrt(np.mean((y_test - preds) ** 2)))
    r2 = float(r2_score(y_test, preds))
    metadata = {
        "model": "HistGradientBoostingRegressor",
        "wrapper": "TransformedTargetRegressor",
        "target": "market_value_gbp",
        "target_units": "GBP",
        "target_transform": "scale_target: x / 1e6 (main.scale_target)",
        "target_inverse": "inverse_scale_target: x * 1e6 (main.inverse_scale_target)",
        "feature_columns": list(app_core.FEATURE_COLUMNS),
        "numeric_features": [c for c in app_core.FEATURE_COLUMNS if c not in cat_features],
        "categorical_features": list(cat_features),
        "training_rows": int(len(df)),
        "training_data_path": "data/raw/player_market_values.csv",
        "mae": mae,
        "rmse": rmse,
        "r2": r2,
        "md_ape_pct": float(median_absolute_percentage_error(y_test, preds)),
        "md_bias_pct": float(median_signed_percentage_error(y_test, preds)),
        "model_files": ["models/transfer_value_model.joblib", "models/transfer_value_model.pkl"],
    }
    METADATA_FILE.write_text(json.dumps(metadata, indent=4))

    snapshot = X_full[app_core.FEATURE_COLUMNS].copy()
    snapshot["market_value_gbp"] = y.values
    snapshot.to_csv(TRAINING_SNAPSHOT, index=False)
    print(f"\nModel saved to {MODEL_FILE} (+ .pkl copy).")
    print(f"Metadata -> {METADATA_FILE}; snapshot ({len(snapshot)} rows) -> {TRAINING_SNAPSHOT}")

if __name__ == "__main__":
    main()