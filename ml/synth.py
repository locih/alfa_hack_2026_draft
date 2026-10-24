"""Дымовой датасет для проверки КОНВЕЙЕРА обучения (ml.train → ml.predict).

ВНИМАНИЕ: данные искусственные, а дефолты сгенерированы по заданной нами же формуле. Это проверяет, что
скрипты работают, признаки совпадают, калибровка и метрики считаются. Это НЕ валидация качества модели и
не повод утверждать, что модель «умеет» оценивать риск. Реальное обучение — только на данных банка.

    python -m ml.synth --n 30000 --out data/smoke.csv
"""
import argparse

import numpy as np
import pandas as pd

from . import features as F


def generate(n: int, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    cat = F.CATEGORICAL
    product = rng.choice(cat["product"], n, p=[.45, .2, .2, .15])
    industry = rng.choice(cat["industry"], n)
    avg = np.exp(rng.normal(14.2, 0.9, n))                       # среднемесячные поступления, ₽
    margin = pd.Series(industry).map({"it": .2, "production": .12, "catering": .08, "construction": .08, "transport": .09, "trade": .05}).to_numpy()
    kind_limit = product == "overdraft"
    amount = np.clip(avg * rng.uniform(0.3, 2.5, n), 100_000, 15_000_000)
    term = np.where(kind_limit, 12, rng.integers(6, 61, n))
    age = np.clip(rng.gamma(2.2, 18, n), 6, 240)
    cv = np.clip(rng.gamma(3, 0.12, n), 0.05, 1.5)
    existing = avg * np.clip(rng.beta(1.3, 6, n), 0, 0.6)
    have_bki = rng.random(n) > 0.06
    overdue = np.where(rng.random(n) < 0.75, 0, rng.integers(1, 60, n)).astype(float)
    i = 0.20 / 12
    pay = np.where(kind_limit, amount * i, amount * i / (1 - (1 + i) ** -term.astype(float)))
    ncf = avg * margin
    p2n = pay / ncf
    dyn = rng.normal(0.02, 0.2, n)
    tax_debt = np.where(rng.random(n) < 0.04, rng.uniform(1e4, 3e5, n), 0.0)

    logit = (-3.6 - 0.012 * (age - 36).clip(-30, 60) + 1.4 * (cv - .3) + 2.2 * existing / avg + 0.7 * np.log1p(p2n * 3)
             + 0.03 * np.nan_to_num(overdue) + (~have_bki) * 0.35 + 0.0000025 * tax_debt - 0.6 * (dyn > 0.1) + 0.5 * (dyn < -0.2)
             + np.where(product == "overdraft", -0.2, 0.0) + rng.normal(0, 0.35, n))
    p = 1 / (1 + np.exp(-logit))
    months = pd.period_range("2023-01", periods=30, freq="M").astype(str)

    df = pd.DataFrame({
        "age_months": age.round(), "tenure_months": np.clip(age * rng.uniform(.1, 1, n), 0, 120).round(),
        "statement_months": rng.choice([0, 6, 12], n, p=[.1, .15, .75]),
        "avg_receipts_log": np.log1p(avg), "receipts_dynamics": dyn, "receipts_cv": cv,
        "min_to_avg": np.clip(1 - cv * rng.uniform(1, 2.2, n), 0.02, 1), "last3_to_avg": np.clip(1 + dyn / 2, 0.2, 2),
        "existing_payments_share": existing / avg, "ncf_log": np.log1p(ncf),
        "bureau_available": have_bki.astype(float),
        "bureau_history_months": np.where(have_bki, rng.integers(0, 120, n), np.nan),
        "bureau_max_overdue_24m": np.where(have_bki, overdue, np.nan),
        "bureau_current_overdue_days": np.where(have_bki, np.where(overdue > 30, overdue / 2, 0), np.nan),
        "bureau_inquiries_3m": np.where(have_bki, rng.poisson(1.5, n), np.nan),
        "bureau_active_loans": np.where(have_bki, rng.poisson(1.2, n), np.nan),
        "tax_debt_log": np.log1p(tax_debt), "tax_debt_days": np.where(tax_debt > 0, rng.integers(1, 120, n), 0),
        "courts_ratio": np.where(rng.random(n) < .05, rng.uniform(0, .04, n), 0.0),
        "msp_registry": (rng.random(n) < .9).astype(float), "priority_industry": (rng.random(n) < .4).astype(float),
        "amount_log": np.log1p(amount), "term": term, "amount_to_avg_receipts": amount / avg,
        "amount_to_annual_receipts": amount / (avg * 12), "payment_to_ncf": p2n,
        "product": product, "industry": industry, "legal_form": rng.choice(cat["legal_form"], n, p=[.7, .3]),
        "statement_source": rng.choice(cat["statement_source"], n, p=[.5, .4, .1]),
        "collateral": np.where(product == "development", "equipment", rng.choice(["none", "guarantor", "realty"], n, p=[.7, .2, .1])),
    })
    df["origination_month"] = rng.choice(months, n)
    df["client_id"] = rng.integers(0, n // 2, n)
    df["observed_months"] = 12 + rng.integers(0, 12, n)
    df["default_12m"] = (rng.random(n) < p).astype(int)
    return df[F.FEATURES + ["origination_month", "client_id", "observed_months", "default_12m"]]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, default=30000)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    df = generate(a.n, a.seed)
    df.to_csv(a.out, index=False)
    print(f"{len(df)} строк → {a.out}; доля дефолтов {df['default_12m'].mean():.2%} (синтетика, только для проверки конвейера)")


if __name__ == "__main__":
    main()
