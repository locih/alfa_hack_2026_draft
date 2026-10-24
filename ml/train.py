"""Обучение PD-модели: градиентный бустинг (LightGBM) → бинарная классификация дефолта → калиброванная PD.

    python -m ml.train --data data/loans.csv --out models/pd_v1 [--time-col origination_month] [--group-col client_id]

Формат данных (один CSV, одна строка = выданный кредит / предложение на момент решения):
  * все колонки из ml.features.FEATURES (категории — строками: working, ООО, bank …; пропуски БКИ — пустые);
  * целевая колонка --target (по умолчанию default_12m): 1, если за 12 месяцев после выдачи была просрочка 90+ дней, иначе 0;
  * необязательные: origination_month (YYYY-MM, для разбиения по времени), client_id (чтобы клиент не попал в две выборки),
    observed_months (сколько месяцев кредит наблюдается; строки с менее чем 12 исключаются как «незрелые»).

ВАЖНО: на выданных кредитах выборка смещена (отказанные заявки не имеют исхода) — см. docs/ml.md про reject inference.
"""
import argparse
import hashlib
import json
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
import sklearn
import yaml
from scipy.stats import ks_2samp
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

from . import features as F
from .predict import pd_to_score

TARGET_DEFINITION = ("1 — просрочка 90+ дней в течение 12 месяцев после выдачи (default_12m); "
                     "в выборку входят только кредиты с окном наблюдения не менее 12 месяцев")

DEFAULT_PARAMS = dict(
    objective="binary", learning_rate=0.03, n_estimators=3000, num_leaves=15, min_child_samples=100,
    subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=10.0,
    monotone_constraints=F.MONOTONE, monotone_constraints_method="intermediate", n_jobs=-1, verbose=-1,
)


def load_data(path: str, target: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    missing = [c for c in F.FEATURES + [target] if c not in df.columns]
    if missing:
        sys.exit(f"В данных нет колонок: {missing}")
    n0 = len(df)
    if "observed_months" in df.columns:
        df = df[df["observed_months"] >= 12]
    df = df[df[target].isin([0, 1])].reset_index(drop=True)
    print(f"Загружено {n0} строк, пригодно для обучения {len(df)}; доля дефолтов {df[target].mean():.2%}")
    return df


def encode_frame(df: pd.DataFrame) -> np.ndarray:
    """Тем же кодом, что и онлайн-инференс (ml.features.encode) — гарантия отсутствия train/serve skew."""
    return np.array([F.encode(r) for r in df[F.FEATURES].to_dict("records")], dtype=float)


def split(df: pd.DataFrame, time_col: str | None, group_col: str | None, seed: int):
    """train 70 % / valid 15 % (ранняя остановка и калибровка) / test 15 % (out-of-time, если есть время)."""
    n = len(df)
    if time_col and time_col in df.columns:
        order = df[time_col].astype(str).sort_values(kind="stable").index.to_numpy()
        a, b = int(n * 0.70), int(n * 0.85)
        parts = (order[:a], order[a:b], order[b:])
        how = f"по времени ({time_col}): test — самые поздние 15 %"
    else:
        rng = np.random.default_rng(seed)
        if group_col and group_col in df.columns:
            groups = df[group_col].unique()
            rng.shuffle(groups)
            ga, gb = groups[: int(len(groups) * 0.70)], groups[int(len(groups) * 0.70): int(len(groups) * 0.85)]
            tr = df.index[df[group_col].isin(ga)].to_numpy()
            va = df.index[df[group_col].isin(gb)].to_numpy()
            te = df.index[~df[group_col].isin(np.concatenate([ga, gb]))].to_numpy()
            parts, how = (tr, va, te), f"случайно по группам ({group_col})"
        else:
            idx = rng.permutation(n)
            parts, how = (idx[: int(n * .7)], idx[int(n * .7): int(n * .85)], idx[int(n * .85):]), "случайно по строкам (нет колонки времени — оценка оптимистична)"
    for name, p in zip(("train", "valid", "test"), parts):
        if len(p) < 100:
            sys.exit(f"Слишком мало строк в {name}: {len(p)}")
    print("Разбиение:", how, [len(p) for p in parts])
    return parts, how


def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def fit_calibration(raw_v, yv, method: str) -> dict:
    if method == "auto":
        method = "platt" if int(yv.sum()) < 300 else "isotonic"       # isotonic переобучается на малом числе дефолтов
    if method == "isotonic":
        iso = IsotonicRegression(y_min=1e-4, y_max=0.999, out_of_bounds="clip").fit(raw_v, yv)
        return {"method": "isotonic", "x": [float(v) for v in iso.X_thresholds_], "y": [float(v) for v in iso.y_thresholds_]}
    lr = LogisticRegression(C=1e6, max_iter=1000).fit(logit(raw_v).reshape(-1, 1), yv)
    return {"method": "platt", "a": float(lr.coef_[0, 0]), "b": float(lr.intercept_[0])}


def apply_calibration(raw, c: dict):
    raw = np.clip(raw, 1e-6, 1 - 1e-6)
    out = np.interp(raw, c["x"], c["y"]) if c["method"] == "isotonic" else 1 / (1 + np.exp(-(c["a"] * logit(raw) + c["b"])))
    return np.clip(out, 1e-4, 0.999)


def psi(expected, actual, bins: int = 10) -> float:
    edges = np.unique(np.quantile(expected, np.linspace(0, 1, bins + 1)))
    edges[0], edges[-1] = -np.inf, np.inf
    e = np.histogram(expected, edges)[0] / len(expected) + 1e-6
    a = np.histogram(actual, edges)[0] / len(actual) + 1e-6
    return float(np.sum((a - e) * np.log(a / e)))


def metrics_block(y, p) -> dict:
    return {"n": int(len(y)), "bad_rate": float(np.mean(y)), "mean_pd": float(np.mean(p)),
            "auc": float(roc_auc_score(y, p)), "gini": float(2 * roc_auc_score(y, p) - 1),
            "ks": float(ks_2samp(p[y == 1], p[y == 0]).statistic),
            "brier": float(brier_score_loss(y, p)), "logloss": float(log_loss(y, p, labels=[0, 1]))}


def decile_table(y, p) -> list[dict]:
    d = pd.DataFrame({"y": y, "p": p})
    d["bin"] = pd.qcut(d["p"], 10, duplicates="drop")
    g = d.groupby("bin", observed=True).agg(n=("y", "size"), mean_pd=("p", "mean"), bad_rate=("y", "mean")).reset_index(drop=True)
    return [{k: float(v) for k, v in r.items()} for r in g.to_dict("records")]


def zone_table(df_test: pd.DataFrame, y, p, cutoffs: dict) -> dict:
    """Какую долю заявок и с каким реальным уровнем дефолта получают зоны «автоодобрение / серая / пропуск» по текущим порогам."""
    out = {}
    for prod, c in cutoffs.items():
        m = (df_test["product"] == prod).to_numpy()
        if m.sum() < 30:
            continue
        pp, yy = p[m] * 100, y[m]
        zones = {"approve": pp <= c["approve"], "decline": pp >= c["decline"]}
        zones["grey"] = ~(zones["approve"] | zones["decline"])
        out[prod] = {z: {"share": float(mask.mean()), "bad_rate": float(yy[mask].mean()) if mask.any() else None} for z, mask in zones.items()}
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True, help="каталог артефактов, например models/pd_v1")
    ap.add_argument("--target", default="default_12m")
    ap.add_argument("--time-col", default="origination_month")
    ap.add_argument("--group-col", default="client_id")
    ap.add_argument("--calibration", choices=["auto", "isotonic", "platt"], default="auto")
    ap.add_argument("--version", default=None)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--params", default="{}", help="JSON с переопределением параметров LightGBM")
    ap.add_argument("--config", default="config/products.yaml", help="откуда брать пороги каскада для таблицы зон")
    a = ap.parse_args()

    raw_bytes = Path(a.data).read_bytes()
    df = load_data(a.data, a.target)
    (tr, va, te), how = split(df, a.time_col, a.group_col, a.seed)
    X = encode_frame(df)
    y = df[a.target].to_numpy(dtype=int)
    cols = F.FEATURES
    Xdf = pd.DataFrame(X, columns=cols)

    params = {**DEFAULT_PARAMS, **json.loads(a.params), "random_state": a.seed}
    clf = lgb.LGBMClassifier(**params)
    clf.fit(Xdf.iloc[tr], y[tr], eval_set=[(Xdf.iloc[va], y[va])], eval_metric="binary_logloss",
            categorical_feature=list(F.CATEGORICAL), callbacks=[lgb.early_stopping(100, verbose=False)])
    booster = clf.booster_
    print(f"Лучшая итерация: {clf.best_iteration_}")

    raw = {k: booster.predict(Xdf.iloc[i]) for k, i in (("train", tr), ("valid", va), ("test", te))}
    calib = fit_calibration(raw["valid"], y[va], a.calibration)
    cal = {k: apply_calibration(v, calib) for k, v in raw.items()}

    metrics = {
        "train": metrics_block(y[tr], cal["train"]), "valid": metrics_block(y[va], cal["valid"]),
        "test": metrics_block(y[te], cal["test"]),
        "test_uncalibrated": metrics_block(y[te], np.clip(raw["test"], 1e-4, 0.999)),
        "psi_train_vs_test": psi(cal["train"], cal["test"]),
        "calibration_deciles_test": decile_table(y[te], cal["test"]),
        "by_product_test": {},
    }
    dte = df.iloc[te]
    for prod in F.CATEGORICAL["product"]:
        m = (dte["product"] == prod).to_numpy()
        if m.sum() >= 50 and 0 < y[te][m].sum() < m.sum():
            metrics["by_product_test"][prod] = metrics_block(y[te][m], cal["test"][m])
    try:
        cutoffs = yaml.safe_load(Path(a.config).read_text(encoding="utf-8"))["ml"]["cutoffs"]
        metrics["zones_test"] = zone_table(dte, y[te], cal["test"], cutoffs)
    except (OSError, KeyError):
        pass

    version = a.version or f"pd-{datetime.now(timezone.utc):%Y%m%d}-{hashlib.sha256(raw_bytes).hexdigest()[:6]}"
    meta = {
        "model_version": version, "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "schema_hash": F.schema_hash(), "features": F.FEATURES, "categorical": F.CATEGORICAL, "monotone_constraints": F.MONOTONE,
        "target": a.target, "target_definition": TARGET_DEFINITION,
        "population": "выданные кредиты (отказанные заявки без исхода; reject inference не применялся)",
        "split": how, "rows": {"train": len(tr), "valid": len(va), "test": len(te)},
        "best_iteration": int(clf.best_iteration_), "params": {k: v for k, v in params.items() if k != "monotone_constraints"},
        "calibration_method": calib["method"], "data_sha256": hashlib.sha256(raw_bytes).hexdigest(),
        "libs": {"lightgbm": lgb.__version__, "sklearn": sklearn.__version__, "numpy": np.__version__,
                 "pandas": pd.__version__, "python": platform.python_version()},
        "summary": {k: metrics["test"][k] for k in ("auc", "gini", "ks", "brier")},
    }
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    booster.save_model(str(out / "model.txt"))
    (out / "calibration.json").write_text(json.dumps(calib), encoding="utf-8")
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    imp = pd.DataFrame({"feature": cols, "gain": booster.feature_importance("gain")}).sort_values("gain", ascending=False)
    imp.to_csv(out / "feature_importance.csv", index=False)

    t = metrics["test"]
    print(f"\nМодель {version} → {out}\n  test: AUC {t['auc']:.3f}  Gini {t['gini']:.3f}  KS {t['ks']:.3f}  Brier {t['brier']:.4f}"
          f"  bad {t['bad_rate']:.2%} / mean PD {t['mean_pd']:.2%}  PSI {metrics['psi_train_vs_test']:.3f}  калибровка: {calib['method']}")
    print("  топ-5 признаков:", ", ".join(imp.head(5)["feature"]))
    print(f"  оценка шкалой скоркарты для PD 5 %: {pd_to_score(0.05):.0f} баллов")


if __name__ == "__main__":
    main()
