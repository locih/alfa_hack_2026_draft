"""Единая формула цены и аннуитетные расчёты. Все параметры — из config/products.yaml."""
import math
from datetime import date, timedelta

from .config import policy


def ceil_half(x: float) -> float:
    return math.ceil(x * 2 - 1e-9) / 2


def term_add(term: int) -> float:
    for upto, add in policy()["pricing"]["term_add"]:
        if term <= upto:
            return add
    return 1.0


def rate_for(product: str, grade: str, term: int, collateral: str, manual: bool, key_rate: float) -> float:
    """Ставка = округление_вверх_до_0,5(K + OpEx + PD×LGD + CapCharge + Маржа + надбавка продукта + надбавка за срок), потолок K+10."""
    pc = policy()
    pr = pc["pricing"]
    if product == "preferential":
        return round(key_rate + pr["preferential_spread"], 2)
    g = pr["grades"][grade]
    lgd = pr["lgd"].get(collateral, pr["lgd"]["none"]) / 100
    opex = pr["opex"]["manual" if manual else "auto"]
    raw = (key_rate + opex + g["pd"] * lgd + g["cap_charge"] + pr["margin"]
           + pc["products"][product]["product_add"] + term_add(term))
    return min(ceil_half(raw), key_rate + pr["cap_over_key"])


def annuity(amount: float, rate: float, n: int) -> int:
    i = rate / 100 / 12
    if i == 0:
        return round(amount / n)
    return round(amount * i / (1 - (1 + i) ** -n))


def amount_from_payment(payment: float, rate: float, n: int) -> float:
    if payment <= 0:
        return 0.0
    i = rate / 100 / 12
    return payment * (1 - (1 + i) ** -n) / i


def schedule(amount: int, rate: float, n: int, start: date | None = None) -> list[dict]:
    start = start or date.today()
    i = rate / 100 / 12
    pay = annuity(amount, rate, n)
    bal, rows = amount, []
    for k in range(1, n + 1):
        interest = round(bal * i)
        principal = bal if k == n else pay - interest
        total = principal + interest
        bal -= principal
        rows.append({"n": k, "date": (start + timedelta(days=30 * k)).isoformat(), "payment": total,
                     "interest": interest, "principal": principal, "balance": bal})
    return rows


def floor_50k(x: float) -> int:
    return int(x // 50_000) * 50_000
