"""«Умный» слой кабинета: прогноз кассового разрыва («Финансовый радар») и единый кредитный лимит («Умный лимит»).

Считает на тех же функциях, что скоринг и политика (build_profile, score, afford, preapproval, pricing),
поэтому цифры клиента и аналитика не расходятся. Модель прогноза намеренно прозрачная (сезонность + тренд + маржа
отрасли + график платежей), чтобы каждую цифру можно было объяснить на защите и в проде заменить на ML-прогноз
той же сигнатурой.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

from . import policy, pricing, scoring

HORIZON_DAYS = 90
MONTHS_AHEAD = 3
OTHER_PAYMENTS_DAY = 25            # прочие обязательства (кредиты в других банках) — 25-го числа
STEP = 50_000
OPEX_DAYS = {1: 0.15, 5: 0.20, 10: 0.25, 20: 0.20, 25: 0.20}   # доли операционных расходов месяца по дням выплат


def _ceil_step(x: float, step: int = STEP) -> int:
    return int(math.ceil(max(x, 0) / step) * step)


def _month_add(d: date, k: int) -> date:
    m = d.month - 1 + k
    return date(d.year + m // 12, m % 12 + 1, 1)


def _days_in(d: date) -> int:
    return (_month_add(d, 1) - timedelta(days=1)).day


def forecast(profile: dict, balance: int, schedules: list[list[dict]], preapproval: list[dict],
             scenario: float = 0.0, today: date | None = None) -> dict:
    """Прогноз свободного остатка на 90 дней и первый кассовый разрыв.

    profile — scoring.build_profile(...); balance — остаток на счёте; schedules — графики выданных кредитов
    (строки pricing.schedule с полями date/payment/paid); preapproval — policy.preapproval(...);
    scenario — стресс к поступлениям (−0.2 = спад на 20 %).
    """
    today = today or date.today()
    avg = profile["avg"]
    margin = policy.policy()["industry_margin"][profile["industry"]]
    receipts = list(profile["receipts"])
    monthly_trend = (1 + profile["dynamics"]) ** (1 / 6) if profile["dynamics"] > -0.95 else 1.0

    months = []
    for k in range(1, MONTHS_AHEAD + 1):
        season = (receipts[k - 1] / avg) if avg else 1.0            # тот же календарный месяц год назад
        season = min(max(season, 0.5), 1.6)
        base_value = avg * season * (monthly_trend ** k)
        value = base_value * (1 + scenario)
        months.append({"month": _month_add(today, k).isoformat()[:7], "receipts": round(value), "baseline": round(base_value),
                       "season": round(season, 2), "free_cash": round(value - base_value * (1 - margin))})

    # обязательные списания в горизонте: платежи по графикам + прочие обязательства 25-го числа
    payments = []
    for rows in schedules:
        for r in rows:
            if r.get("paid"):
                continue
            d = date.fromisoformat(r["date"])
            if today < d <= today + timedelta(days=HORIZON_DAYS):
                payments.append({"date": d.isoformat(), "amount": r["payment"], "kind": "loan"})
    for k in range(0, MONTHS_AHEAD + 1):
        d = _month_add(today, k).replace(day=min(OTHER_PAYMENTS_DAY, _days_in(_month_add(today, k))))
        if today < d <= today + timedelta(days=HORIZON_DAYS) and profile["existing_payments"]:
            payments.append({"date": d.isoformat(), "amount": profile["existing_payments"], "kind": "other"})
    payments.sort(key=lambda x: x["date"])
    by_day = {}
    for pmt in payments:
        by_day[pmt["date"]] = by_day.get(pmt["date"], 0) + pmt["amount"]

    monthly_loans = sum(r["payment"] for rows in schedules for r in rows[:1]) if schedules else 0
    cushion = round(profile["existing_payments"] + monthly_loans)          # подушка — месяц обязательных платежей
    # операционные расходы (поступления × (1 − маржа)) уходят в фиксированные дни, поступления копятся равномерно —
    # так виден внутримесячный провал: аренда 1-го, зарплата 5-го и 20-го, поставщики 10-го и 25-го
    path, bal, gap = [], float(balance), None
    low = (today.isoformat(), float(balance))
    for i in range(1, HORIZON_DAYS + 1):
        d = today + timedelta(days=i)
        k = (d.year - today.year) * 12 + d.month - today.month
        m = months[min(k - 1, MONTHS_AHEAD - 1)] if k >= 1 else None
        gross = m["receipts"] if m else avg * (1 + scenario)
        baseline = m["baseline"] if m else avg                      # расходы инерционны: считаем от базового прогноза, не от стресса
        daily_in = gross / _days_in(d)
        opex = baseline * (1 - margin) * OPEX_DAYS.get(d.day, 0.0)
        bal += daily_in - opex - by_day.get(d.isoformat(), 0)
        if opex:
            payments.append({"date": d.isoformat(), "amount": round(opex), "kind": "opex"})
        if bal < low[1]:
            low = (d.isoformat(), bal)
        if gap is None and bal < cushion:
            gap = {"date": d.isoformat(), "day": i}
        path.append({"date": d.isoformat(), "balance": round(bal)})

    payments.sort(key=lambda x: x["date"])
    free = max(0, round(low[1] - cushion))
    offer = None
    if gap:
        need = _ceil_step(cushion - low[1])
        gap.update(amount=need, lowest_date=low[0], lowest_balance=round(low[1]))
        avail = {p["product"]: p for p in preapproval if p.get("available")}
        pick = next((k for k in ("overdraft", "working", "development") if k in avail and avail[k]["max_amount"] >= need), None)
        if pick:
            offer = {"product": pick, "amount": min(need, avail[pick]["max_amount"]), "term": 12 if pick != "development" else 24,
                     "rate_from": avail[pick]["rate_from"], "purpose": "gap"}
    return {"horizon_days": HORIZON_DAYS, "today": today.isoformat(), "balance": balance, "cushion": cushion,
            "fact": receipts, "months": months, "payments": payments, "path": path,
            "gap": gap, "free_cash": free, "offer": offer, "scenario": scenario,
            "assumptions": {"margin": margin, "monthly_trend": round(monthly_trend, 4),
                            "model": "поступления: сезонность того же месяца год назад × тренд полугодия (× стресс-сценарий); расходы инерционны — от базового прогноза × (1 − маржа отрасли) в дни зарплат, аренды и поставщиков; списания — график платежей и прочие обязательства 25-го числа"}}


def limit(profile: dict, key_rate: float, loans: list[dict], preapproval: list[dict]) -> dict:
    """Единый кредитный лимит клиента и что его поднимет (пересчёт теми же функциями скоринга/политики)."""
    avail = [p for p in preapproval if p.get("available")]
    total = max((p["max_amount"] for p in avail), default=0)
    used = sum(l["outstanding"] for l in loans if not l.get("repaid"))
    sc = scoring.score(profile)
    af = policy.afford(profile, sc["grade"])

    def limit_for(p: dict) -> int:
        s = scoring.score(p)
        if scoring.stop_rules(p) or s["grade"] in ("D", "E") or not p["bureau_ok"]:
            return 0
        a = policy.afford(p, s["grade"])
        best = 0
        for k, prod in policy.policy()["products"].items():
            if prod["kind"] != "annuity" or policy.eligibility(k, p):
                continue
            term = {"working": 24, "development": 48, "preferential": 24}.get(k, 24)
            r = pricing.rate_for(k, s["grade"], term, "none", False, key_rate)
            mx = pricing.floor_50k(min(pricing.amount_from_payment(a["p_max"], r, term), prod["max_amount"]))
            best = max(best, min(mx, policy.auto_limit(k, s["grade"])))
        return best

    growth = []
    base = limit_for(profile)
    if profile.get("statement_source") != "bank" or profile.get("statement_months", 0) < 12:
        p2 = dict(profile, statement_source="bank", statement_months=12)
        growth.append({"id": "statement", "title": "Подключите выписку: 12 месяцев оборотов в нашем банке" if profile.get("statement_source") == "other" else "Подключите выписку другого банка",
                       "effect": max(0, limit_for(p2) - base), "how": "подтверждённость данных — фактор 1.4 скоркарты"})
    b = profile.get("bureau") or {}
    if b and (b.get("max_overdue_24m", 0) > 0 or b.get("inquiries_3m", 0) > 2):
        p3 = dict(profile, bureau=dict(b, max_overdue_24m=0, inquiries_3m=min(b.get("inquiries_3m", 0), 1)))
        growth.append({"id": "discipline", "title": "Три месяца без просрочек и новых запросов в БКИ", "effect": max(0, limit_for(p3) - base),
                       "how": "кредитная история — факторы 3.1 и 3.3"})
    if profile["existing_payments"] > 0:
        p4 = dict(profile, existing_payments=0)
        growth.append({"id": "refinance", "title": "Закройте или рефинансируйте кредиты в других банках", "effect": max(0, limit_for(p4) - base),
                       "how": "платёжная нагрузка — DSCR и доля платежей"})
    # залог: в политике снижает ставку — считаем лимит при ставке с обеспечением
    try:
        grade = sc["grade"]
        r0 = pricing.rate_for("development", grade, 48, "none", False, key_rate)
        r1 = pricing.rate_for("development", grade, 48, "equipment", False, key_rate)
        m0 = pricing.amount_from_payment(af["p_max"], r0, 48); m1 = pricing.amount_from_payment(af["p_max"], r1, 48)
        growth.append({"id": "collateral", "title": "Залог оборудования или транспорта", "effect": max(0, pricing.floor_50k(m1) - pricing.floor_50k(m0)),
                       "how": f"ставка ниже на {round(r0 - r1, 1)} п.п. при том же платеже"})
    except Exception:  # noqa: BLE001 — рост по залогу необязателен
        pass
    return {"limit": total, "used": used, "available": max(0, total - used), "p_max": af["p_max"],
            "ncf": af["ncf"], "products": [{"product": p["product"], "max_amount": p["max_amount"], "rate_from": p.get("rate_from")} for p in avail],
            "growth": sorted(growth, key=lambda g: -g["effect"]),
            "note": "лимит = платёжеспособность по оборотам в одной сумме; продукты внутри лимита оформляются без новой проверки"}
