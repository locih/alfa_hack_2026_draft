"""Инференс PD-модели: загрузка артефактов, калиброванная PD, вклады признаков, батч-скоринг CSV.

Артефакты каталога модели (без pickle — только текст и JSON, безопасно загружать):
  model.txt (LightGBM), calibration.json, meta.json, metrics.json, feature_importance.csv

    python -m ml.predict --model models/pd_v1 --data applications.csv --out scored.csv
"""
import argparse
import csv
import json
import math
import os
from pathlib import Path

from . import features as F


class ModelUnavailable(Exception):
    pass


def pd_to_score(pd: float) -> float:
    """Шкала PDO как у скоркарты: 60 баллов = PD 5 %, +15 баллов удваивают шансы. Возвращает 0..100."""
    pd = min(max(pd, 1e-6), 1 - 1e-6)
    s = 60 + 15 * math.log2(((1 - pd) / pd) / 19)
    return max(0.0, min(100.0, s))


class PDModel:
    def __init__(self, booster, calibration: dict, meta: dict, path: str):
        import numpy as np
        self._np, self.booster, self.calibration, self.meta, self.path = np, booster, calibration, meta, path
        self.version = meta["model_version"]

    @classmethod
    def load(cls, path: str) -> "PDModel":
        p = Path(path)
        try:
            meta = json.loads((p / "meta.json").read_text(encoding="utf-8"))
            calibration = json.loads((p / "calibration.json").read_text(encoding="utf-8"))
            if meta["schema_hash"] != F.schema_hash():
                raise ModelUnavailable(f"набор признаков модели ({meta['schema_hash']}) не совпадает с кодом ({F.schema_hash()}): переобучите модель")
            import lightgbm as lgb
            booster = lgb.Booster(model_file=str(p / "model.txt"))
        except ModelUnavailable:
            raise
        except Exception as e:                                   # нет файлов, нет libomp/lightgbm, битый JSON
            raise ModelUnavailable(f"{type(e).__name__}: {e}") from e
        return cls(booster, calibration, meta, str(p))

    # --- калибровка ---
    def _calibrate(self, raw):
        np, c = self._np, self.calibration
        raw = np.clip(raw, 1e-6, 1 - 1e-6)
        if c["method"] == "isotonic":
            out = np.interp(raw, c["x"], c["y"])
        else:                                                    # Platt: сигмоида от логита сырой оценки
            z = c["a"] * np.log(raw / (1 - raw)) + c["b"]
            out = 1 / (1 + np.exp(-z))
        return np.clip(out, 1e-4, 0.999)

    def predict_many(self, rows: list[dict]) -> list[float]:
        X = self._np.array([F.encode(r) for r in rows], dtype=float)
        return [float(v) for v in self._calibrate(self.booster.predict(X))]

    def predict_pd(self, features: dict) -> float:
        return self.predict_many([features])[0]

    def explain(self, features: dict, top: int = 5) -> list[tuple[str, float]]:
        """Вклады признаков в логит (SHAP по деревьям LightGBM). Положительный вклад — повышает PD."""
        X = self._np.array([F.encode(features)], dtype=float)
        contrib = self.booster.predict(X, pred_contrib=True)[0][:-1]
        pairs = sorted(zip(F.FEATURES, (float(c) for c in contrib)), key=lambda t: -abs(t[1]))
        return pairs[:top]


def load_default() -> "PDModel | None":
    """Модель из MODEL_DIR (по умолчанию models/pd_current); при любой проблеме — None (приложение уходит на скоркарту)."""
    path = os.environ.get("MODEL_DIR", "models/pd_current")
    if not (Path(path) / "meta.json").exists():
        return None
    try:
        return PDModel.load(path)
    except ModelUnavailable as e:
        print(f"[ml] модель не загружена, используется скоркарта: {e}")
        return None


def main() -> None:
    ap = argparse.ArgumentParser(description="Батч-скоринг CSV: добавляет колонки pd, score")
    ap.add_argument("--model", required=True)
    ap.add_argument("--data", required=True, help="CSV с колонками признаков (см. ml/features.py: FEATURES)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    model = PDModel.load(a.model)
    with open(a.data, encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    pds = model.predict_many(rows)
    with open(a.out, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) + ["pd", "score"])
        w.writeheader()
        for r, p in zip(rows, pds):
            w.writerow({**r, "pd": f"{p:.5f}", "score": f"{pd_to_score(p):.1f}"})
    print(f"Готово: {len(rows)} строк → {a.out} (модель {model.version})")


if __name__ == "__main__":
    main()
