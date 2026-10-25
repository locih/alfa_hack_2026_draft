"""Кредитная политика: допуск продукта, максимальная сумма по DSCR, цена, встречное предложение, маршрут.

Скоринг (scoring.py) отвечает за риск клиента; здесь — решение по конкретной заявке.
Порядок встречного предложения: как просили → больший срок → меньшая сумма → отказ.
"""
from datetime import datetime, timedelta, timezone

from . import pricing, scoring
from .config import policy
from .reasons import FACTOR_REASON, HELPED, reason

SCORECARD_VERSION = "2026-10-23.1"


def eligibility(product: str, p: dict) -> list[dict]:
    prod = policy()["products"][product]
    out = []
    if p["age_months"] < prod.get("min_business_months", 0):
        out.append(reason("R01"))
    if p["tenure_months"] < prod.get("min_tenure_months", 0):
        out.append(reason("R19"))
    if prod.get("needs_msp_priority") and not (p["msp_registry"] and p["priority_industry"]):
        out.append(reason("R19"))
    return out


def afford(p: dict, grade: str) -> dict:
    pc = policy()
    g = pc["pricing"]["grades"][grade]
    ncf = p["avg"] * pc["industry_margin"][p["industry"]]
    by_dscr = ncf / g["dscr"] - p["existing_payments"]
    by_share = g["debt_share"] * p["avg"] - p["existing_payments"]
    return {"ncf": round(ncf), "dscr_target": g["dscr"], "debt_share": g["debt_share"],
            "existing": p["existing_payments"], "p_max": max(round(min(by_dscr, by_share), 0), 0)}


def _terms_after(term: int, max_term: int) -> list[int]:
    ts = list(range(term + 6, max_term + 1, 6))
    if max_term > term and max_term not in ts:
        ts.append(max_term)
    return ts


def auto_limit(product: str, grade: str) -> int:
    return policy()["products"][product]["auto_limits"].get(grade, 0)


def _offer_terms(product: str, grade: str, amount: int, term: int, collateral: str, manual: bool, key_rate: float,
                 kind: str) -> dict:
    prod = policy()["products"][product]
    rate = pricing.rate_for(product, grade, term, collateral, manual, key_rate)
    o = {"type": kind, "product": product, "amount": int(amount), "term": term, "rate": rate, "collateral": collateral,
         "key_rate_snapshot": key_rate, "grade": grade, "product_title": prod["title"],
         "valid_until": (datetime.now(timezone.utc) + timedelta(days=14)).isoformat(timespec="seconds"),
         "fee_text": prod["fee"]}
    if prod["kind"] == "limit":
        o.update(payment=None, total=None, overpayment=None,
                 fee=round(amount * prod["limit_fee_pct"] / 100), interest_30d=round(amount * rate / 100 * 30 / 365))
    else:
        pay = pricing.annuity(amount, rate, term)
        total = sum(r["payment"] for r in pricing.schedule(int(amount), rate, term))
        o.update(payment=pay, total=total, overpayment=total - amount, fee=0)
    return o


def recommend(product: str, grade: str, p: dict, amount: int, term: int, collateral: str, key_rate: float,
              manual: bool) -> tuple[dict | None, dict]:
    """Возвращает (предложение | None, расчёт платёжеспособности)."""
    prod = policy()["products"][product]
    af = afford(p, grade)
    if prod["kind"] == "limit":
        cap = min(prod["limit_share_of_receipts"] * p["avg"], prod["max_amount"])
        af["limit_max"] = pricing.floor_50k(cap)
        if amount <= cap:
            return _offer_terms(product, grade, amount, term, collateral, manual, key_rate, "AS_REQUESTED"), af
        lim = pricing.floor_50k(cap)
        if lim >= max(0.3 * amount, prod["min_amount"]):
            return _offer_terms(product, grade, lim, term, collateral, manual, key_rate, "COUNTER"), af
        return None, af

    def amax(n):
        return pricing.amount_from_payment(af["p_max"], pricing.rate_for(product, grade, n, collateral, manual, key_rate), n)

    af["amax_requested_term"] = pricing.floor_50k(amax(term))
    if amount <= amax(term):
        return _offer_terms(product, grade, amount, term, collateral, manual, key_rate, "AS_REQUESTED"), af
    for n in _terms_after(term, prod["max_term"]):          # та же сумма, больший срок
        if amount <= amax(n):
            return _offer_terms(product, grade, amount, n, collateral, manual, key_rate, "COUNTER"), af
    n = prod["max_term"]                                     # меньшая сумма на максимальном сроке
    a = pricing.floor_50k(min(amax(n), prod["max_amount"]))
    af["amax_max_term"] = a
    if a >= max(0.3 * amount, prod["min_amount"]) and a < amount:
        return _offer_terms(product, grade, a, n, collateral, manual, key_rate, "COUNTER"), af
    return None, af


def soft_flags(p: dict, amount: int) -> list[str]:
    flags = []
    if p["age_months"] < 12 and (amount > 3_000_000 or amount > 6 * p["avg"]):
        flags.append("Молодой бизнес и крупная сумма относительно оборотов")
    if p["dynamics"] > 1.0:
        flags.append("Резкий рост поступлений перед заявкой")
    return flags


def _hurts(sc: dict, limit: int = 3) -> list[dict]:
    losses = sorted((f for f in sc["factors"] if f["max"] - f["points"] > 0 and f["id"] in FACTOR_REASON),
                    key=lambda f: f["points"] - f["max"])
    out, seen = [], set()
    for f in losses:
        code = FACTOR_REASON[f["id"]]
        if code not in seen:
            seen.add(code)
            out.append(reason(code))
        if len(out) == limit:
            break
    return out


def _helped(sc: dict, limit: int = 3) -> list[dict]:
    best = [f for f in sc["factors"] if f["points"] == f["max"] and f["id"] in HELPED]
    best.sort(key=lambda f: -f["max"])
    return [{"code": "OK" + f["id"], "direction": "helped", "text": HELPED[f["id"]], "action": ""} for f in best[:limit]]


helped_reasons = _helped


def evaluate(app: dict, client: dict, enrichment: dict, key_rate: float, mode: str = "rules") -> dict:
    """Полное решение системы по заявке. outcome: approve | counter | manual | decline.
    mode: rules — скоркарта и политика; ml_cascade — PD-модель и каскад по продуктам (app/cascade.py)."""
    if mode == "ml_cascade":
        from . import cascade
        return cascade.evaluate_cascade(app, client, enrichment, key_rate)
    pc = policy()
    product, amount, term, collateral = app["product"], app["amount"], app["term"], app["collateral"]
    p = scoring.build_profile(client, enrichment)
    dec = {"policy_version": pc["version"], "scorecard_version": SCORECARD_VERSION, "key_rate": key_rate,
           "stops": scoring.stop_rules(p), "flags": soft_flags(p, amount), "bureau_ok": p["bureau_ok"]}
    elig = eligibility(product, p)

    if dec["stops"]:
        dec.update(outcome="decline", reasons=[reason(h["code"]) for h in dec["stops"][:1]], stage="stop-rule")
        return dec
    if elig:
        dec.update(outcome="decline", reasons=elig[:1], stage="eligibility")
        return dec

    sc = scoring.score(p)
    g, total = sc["grade"], sc["total"]
    zone = pc["manual_zone"]
    in_zone = any(abs(total - b) <= zone for b in (35, 50))
    dec.update(score=total, grade=g, pd=scoring.pd_percent(total), factors=sc["factors"], partial=sc["partial"])

    manual_reasons = []
    if not p["bureau_ok"]:
        manual_reasons.append("Данные БКИ недоступны")
    if g == "D":
        manual_reasons.append("Грейд D — только ручной разбор")
    if in_zone:
        manual_reasons.append(f"Балл {total} рядом с границей грейда (±{zone})")
    if len(dec["flags"]) >= 2:
        manual_reasons.append("Два и более мягких флага риска")

    if g == "E" and not in_zone and p["bureau_ok"]:
        dec.update(outcome="decline", reasons=_hurts(sc) or [reason("R02")], stage="score")
        return dec

    calc_grade = "D" if g == "E" else g
    rec, af = recommend(product, calc_grade, p, amount, term, collateral, key_rate, manual=bool(manual_reasons))
    dec["afford"] = af
    dec["recommendation"] = rec
    if rec and rec["amount"] > auto_limit(product, g):
        manual_reasons.append(f"Сумма выше лимита автоматического решения ({auto_limit(product, g):,} ₽)".replace(",", " "))

    if manual_reasons:
        dec.update(outcome="manual", manual_reasons=manual_reasons, reasons=[reason("R18")] + ([reason("R05")] if not p["bureau_ok"] else []))
        return dec
    if rec is None:
        dec.update(outcome="decline", reasons=[reason("R02")] + _hurts(sc, 2), stage="affordability")
        return dec
    if rec["type"] == "AS_REQUESTED":
        dec.update(outcome="approve", reasons=_helped(sc))
    else:
        dec.update(outcome="counter", reasons=[reason("R13", text=(
            f"Запрошенная сумма превышает комфортный платёж; предлагаем {rec['amount']:,} ₽ на {rec['term']} мес.".replace(",", " ")))] + _hurts(sc, 2))
    return dec


def quote(product: str, grade: str, p: dict, amount: int, term: int, collateral: str, key_rate: float) -> dict:
    """Симулятор «что если»: цена, платёж, запас и максимальная сумма на срок."""
    prod = policy()["products"][product]
    o = _offer_terms(product, grade, amount, term, collateral, False, key_rate, "QUOTE")
    af = afford(p, grade)
    base = pricing.rate_for(product, grade, term, "none", False, key_rate)       # ставка без обеспечения — график для неё не нужен
    res = {"collateral_effect": round(base - o["rate"], 2), "rate": o["rate"], "payment": o["payment"], "total": o["total"], "overpayment": o["overpayment"],
           "fee": o["fee"], "interest_30d": o.get("interest_30d"), "p_max": af["p_max"], "grade": grade}
    if prod["kind"] == "limit":
        cap = pricing.floor_50k(min(prod["limit_share_of_receipts"] * p["avg"], prod["max_amount"]))
        res.update(max_amount=cap, fits=amount <= cap)
    else:
        mx = pricing.floor_50k(min(pricing.amount_from_payment(af["p_max"], o["rate"], term), prod["max_amount"]))
        res.update(max_amount=mx, fits=bool(o["payment"] <= af["p_max"]),
                   headroom=round(1 - o["payment"] / af["p_max"], 2) if af["p_max"] else None)
    return res


def preapproval(client: dict, enrichment: dict, key_rate: float) -> list[dict]:
    """Предодобрение по данным, которые банк уже знает (без заявки)."""
    p = scoring.build_profile(client, enrichment)
    out = []
    if scoring.stop_rules(p):
        return [{"product": k, "available": False, "message": "Сейчас предодобрение недоступно"} for k in policy()["products"]]
    sc = scoring.score(p)
    g = sc["grade"]
    for k, prod in policy()["products"].items():
        if eligibility(k, p):
            out.append({"product": k, "available": False, "message": "Недоступно по условиям продукта"})
            continue
        if not p["bureau_ok"] or g in ("D", "E"):
            out.append({"product": k, "available": False,
                        "message": "Предварительный расчёт недоступен — подайте заявку, специалист рассмотрит её" if not p["bureau_ok"]
                        else "Условия обсудим при подаче заявки"})
            continue
        term = {"working": 24, "overdraft": 12, "development": 48, "preferential": 24}[k]
        af = afford(p, g)
        if prod["kind"] == "limit":
            mx = pricing.floor_50k(min(prod["limit_share_of_receipts"] * p["avg"], prod["max_amount"]))
        else:
            r = pricing.rate_for(k, g, term, "equipment" if k == "development" else "none", False, key_rate)
            mx = pricing.floor_50k(min(pricing.amount_from_payment(af["p_max"], r, term), prod["max_amount"]))
        mx = min(mx, auto_limit(k, g))
        if mx < prod["min_amount"]:
            out.append({"product": k, "available": False, "message": "Условия обсудим при подаче заявки"})
            continue
        rate_from = pricing.rate_for(k, g, prod["min_term"], "equipment" if k == "development" else "none", False, key_rate)
        out.append({"product": k, "available": True, "max_amount": mx, "rate_from": rate_from, "grade": g})
    return out
