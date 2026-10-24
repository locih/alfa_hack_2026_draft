"""Признаки PD-модели — единые для обучения, батч-скоринга и онлайн-инференса.

Чистый Python (без numpy/pandas), поэтому приложение строит признаки без тяжёлых зависимостей.
Одна модель на все продукты: продукт и параметры заявки (сумма, срок, обеспечение) — признаки,
а PD оценивается для конкретного предложения (клиент + продукт + сумма + срок).
"""
import hashlib
import json
import math

NAN = float("nan")

CATEGORICAL = {
    "product": ["working", "overdraft", "development", "preferential"],
    "industry": ["it", "production", "catering", "construction", "transport", "trade"],
    "legal_form": ["ООО", "ИП"],
    "statement_source": ["bank", "other", "none"],
    "collateral": ["none", "guarantor", "equipment", "realty"],
}

# (признак, ограничение монотонности по PD: +1 — рост признака повышает PD, -1 — снижает, 0 — без ограничения)
_NUMERIC = [
    # бизнес и данные
    ("age_months", -1), ("tenure_months", -1), ("statement_months", -1),
    # денежный поток (из данных банка)
    ("avg_receipts_log", -1), ("receipts_dynamics", 0), ("receipts_cv", 1), ("min_to_avg", -1),
    ("last3_to_avg", 0), ("existing_payments_share", 1), ("ncf_log", -1),
    # бюро кредитных историй (NaN, если БКИ недоступно)
    ("bureau_available", 0), ("bureau_history_months", -1), ("bureau_max_overdue_24m", 1),
    ("bureau_current_overdue_days", 1), ("bureau_inquiries_3m", 1), ("bureau_active_loans", 0),
    # ФНС / реестры
    ("tax_debt_log", 1), ("tax_debt_days", 1), ("courts_ratio", 1), ("msp_registry", 0), ("priority_industry", 0),
    # параметры предложения
    ("amount_log", 0), ("term", 0), ("amount_to_avg_receipts", 1), ("amount_to_annual_receipts", 1), ("payment_to_ncf", 1),
]
NUMERIC = [n for n, _ in _NUMERIC]
FEATURES = NUMERIC + list(CATEGORICAL)
MONOTONE = [dict(_NUMERIC).get(f, 0) for f in FEATURES]          # для категориальных — 0
INDICATIVE_RATE = 20.0                                          # % — ставка для признака payment_to_ncf (не цена!)


def schema_hash() -> str:
    """Отпечаток набора признаков: модель с другим отпечатком не загружается (защита от рассинхрона)."""
    return hashlib.sha256(json.dumps([FEATURES, CATEGORICAL], ensure_ascii=False).encode()).hexdigest()[:12]


def _log(x: float) -> float:
    return math.log1p(max(x, 0.0))


def indicative_payment(amount: float, term: int, kind: str) -> float:
    i = INDICATIVE_RATE / 100 / 12
    if kind == "limit":                       # лимит овердрафта: проценты по полному использованию
        return amount * i
    return amount * i / (1 - (1 + i) ** -term)


def build(profile: dict, *, product: str, kind: str, amount: float, term: int, collateral: str,
          legal_form: str, ncf_margin: float) -> dict:
    """Признаки одного предложения. `profile` — результат scoring.build_profile (данные всех источников)."""
    r = profile["receipts"]
    avg = profile["avg"] or 1.0
    ncf = avg * ncf_margin
    b = profile["bureau"] if profile.get("bureau_ok") else None
    return {
        "age_months": profile["age_months"], "tenure_months": profile["tenure_months"],
        "statement_months": profile["statement_months"],
        "avg_receipts_log": _log(avg), "receipts_dynamics": profile["dynamics"], "receipts_cv": profile["cv"],
        "min_to_avg": min(r) / avg, "last3_to_avg": (sum(r[-3:]) / 3) / avg,
        "existing_payments_share": profile["existing_payments"] / avg, "ncf_log": _log(ncf),
        "bureau_available": 1.0 if b else 0.0,
        "bureau_history_months": b["history_months"] if b else NAN,
        "bureau_max_overdue_24m": b["max_overdue_24m"] if b else NAN,
        "bureau_current_overdue_days": b["current_overdue_days"] if b else NAN,
        "bureau_inquiries_3m": b["inquiries_3m"] if b else NAN,
        "bureau_active_loans": b["active_loans"] if b else NAN,
        "tax_debt_log": _log(profile["tax_debt"]), "tax_debt_days": profile["tax_debt_days"],
        "courts_ratio": profile["courts_ratio"],
        "msp_registry": float(bool(profile["msp_registry"])), "priority_industry": float(bool(profile["priority_industry"])),
        "amount_log": _log(amount), "term": term,
        "amount_to_avg_receipts": amount / avg, "amount_to_annual_receipts": amount / (avg * 12),
        "payment_to_ncf": indicative_payment(amount, term, kind) / ncf if ncf else NAN,
        "product": product, "industry": profile["industry"], "legal_form": legal_form,
        "statement_source": profile["statement_source"], "collateral": collateral,
    }


def encode(features: dict) -> list[float]:
    """Вектор в порядке FEATURES. Категории → индекс словаря, неизвестные и пропуски → NaN (LightGBM видит как missing)."""
    row = []
    for f in FEATURES:
        v = features.get(f)
        if f in CATEGORICAL:
            vocab = CATEGORICAL[f]
            row.append(float(vocab.index(v)) if v in vocab else NAN)
        else:
            try:
                row.append(NAN if v is None or v == "" else float(v))
            except (TypeError, ValueError):
                row.append(NAN)
    return row


# Какие признаки объясняют решение клиенту: признак → код причины (см. app/reasons.py)
FEATURE_REASON = {
    "age_months": "R01", "avg_receipts_log": "R02", "ncf_log": "R02", "payment_to_ncf": "R02", "amount_to_avg_receipts": "R13",
    "amount_to_annual_receipts": "R13", "receipts_dynamics": "R09", "last3_to_avg": "R09", "receipts_cv": "R10", "min_to_avg": "R10",
    "existing_payments_share": "R03", "bureau_active_loans": "R03", "bureau_max_overdue_24m": "R04", "bureau_current_overdue_days": "R04",
    "bureau_history_months": "R05", "bureau_available": "R05", "bureau_inquiries_3m": "R06", "tax_debt_log": "R07", "tax_debt_days": "R07",
    "courts_ratio": "R08", "statement_months": "R12", "statement_source": "R12",
}
