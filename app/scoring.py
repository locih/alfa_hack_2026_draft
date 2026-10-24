"""Скоринг (оценка риска клиента, не зависит от суммы) и стоп-правила.

Карта — экспертная калибровка (14 факторов, 100 баллов); не использует возраст, пол, семейное положение
и регион владельца. Для аддитивной карты причина решения = потерянные баллы фактора (SHAP не нужен).
"""
import statistics

from .config import policy

STOP_RULES = {
    "H01": ("R01", "Возраст бизнеса меньше 6 месяцев"),
    "H02": ("R16", "Банкротство, ликвидация или прекращение деятельности"),
    "H03": ("R16", "Недостоверные сведения в ЕГРЮЛ/ЕГРИП"),
    "H04": ("R16", "Дисквалификация руководителя"),
    "H05": ("R17", "Блокировка счетов"),
    "H06": ("R07", "Налоговая недоимка свыше 50 тыс. ₽ или свыше 30 дней"),
    "H07": ("R04", "Текущая просрочка более 30 дней или просрочка 60+ дней за 24 месяца"),
    "H08": ("R08", "Иски и исполнительные производства свыше 5 % годового оборота"),
    "H10": ("R15", "Совпадение с перечнем санкций (флаг)"),
}


def metrics(receipts: list[int]) -> dict:
    avg = statistics.fmean(receipts)
    prev, last = sum(receipts[:6]), sum(receipts[6:])
    return {"avg": avg, "dynamics": last / prev - 1 if prev else 0.0,
            "cv": statistics.pstdev(receipts) / avg if avg else 9.9}


def build_profile(client: dict, enrichment: dict) -> dict:
    """Единый профиль для скоринга и политики из ответов источников."""
    eg, fn, bk = (enrichment[k]["data"] for k in ("egrul", "fns", "bank"))
    p = {
        "age_months": eg["age_months"], "egrul_status": eg["status"], "unreliable": eg["unreliable"],
        "disqualified": eg["disqualified"], "industry": client["industry"],
        "tenure_months": bk["tenure_months"], "statement_source": bk["statement_source"],
        "statement_months": bk["statement_months"], "receipts": bk["receipts"],
        "existing_payments": bk["existing_payments"],
        "tax_debt": fn["tax_debt"], "tax_debt_days": fn["tax_debt_days"], "courts_ratio": fn["courts_ratio"],
        "sanctions": fn["sanctions"], "blocked": fn["blocked"],
        "msp_registry": fn["msp_registry"], "priority_industry": fn["priority_industry"],
        "bureau": enrichment["bureau"]["data"], "bureau_ok": enrichment["bureau"]["status"] == "OK",
    }
    p.update(metrics(p["receipts"]))
    return p


def stop_rules(p: dict) -> list[dict]:
    hits = []

    def hit(h):
        code, text = STOP_RULES[h]
        hits.append({"id": h, "code": code, "text": text})

    if p["age_months"] < 6:
        hit("H01")
    if p["egrul_status"] != "active":
        hit("H02")
    if p["unreliable"]:
        hit("H03")
    if p["disqualified"]:
        hit("H04")
    if p["blocked"]:
        hit("H05")
    if p["tax_debt"] > 50_000 or (p["tax_debt"] > 0 and p["tax_debt_days"] > 30):
        hit("H06")
    b = p["bureau"]
    if b and (b["current_overdue_days"] > 30 or b["max_overdue_24m"] >= 60):
        hit("H07")
    if p["courts_ratio"] >= 0.05:
        hit("H08")
    if p["sanctions"]:
        hit("H10")
    return hits


def _band(v, bands):
    """bands: [(верхняя граница (не включая), баллы), ...]; последний — «иначе»."""
    for upto, pts in bands[:-1]:
        if v < upto:
            return pts
    return bands[-1][1]


def score(p: dict) -> dict:
    pc = policy()
    ind = pc["industry"][p["industry"]]
    b = p["bureau"]
    F = []

    def add(fid, block, name, pts, mx, value):
        F.append({"id": fid, "block": block, "name": name, "points": pts, "max": mx, "value": value})

    # 1. Бизнес и достоверность (25)
    add("1.1", "Бизнес и данные", "Возраст бизнеса", _band(p["age_months"], [(6, 0), (12, 2), (24, 5), (60, 8), (0, 10)]), 10,
        f"{p['age_months']} мес.")
    add("1.2", "Бизнес и данные", "Стаж в банке", _band(p["tenure_months"], [(1, 0), (6, 1), (24, 3), (0, 5)]), 5,
        f"{p['tenure_months']} мес.")
    add("1.3", "Бизнес и данные", "Риск отрасли", ind["points"], 5, ind["title"])
    src, sm = p["statement_source"], p["statement_months"]
    stm = 5 if (src == "bank" and sm >= 12) else 3 if (src == "other" or (src == "bank" and sm >= 6)) else 0
    add("1.4", "Бизнес и данные", "Подтверждённость данных", stm, 5,
        {"bank": "выписка нашего банка", "other": "выписка другого банка", "none": "нет выписки"}[src])
    # 2. Денежный поток (33)
    avg_k = round(p["avg"] / 1000)
    add("2.1", "Денежный поток", "Среднемесячные поступления", _band(avg_k, [(300, 0), (1000, 3), (3000, 6), (10000, 8), (0, 10)]), 10,
        f"{round(avg_k):,} тыс. ₽".replace(",", " "))
    add("2.2", "Денежный поток", "Динамика поступлений", _band(p["dynamics"], [(-0.30, 0), (-0.10, 3), (0.10, 5), (9, 7)]), 7,
        f"{p['dynamics'] * 100:+.0f} %")
    add("2.3", "Денежный поток", "Стабильность поступлений", _band(p["cv"], [(0.25 + 1e-9, 8), (0.5, 5), (0.8, 2), (0, 0)]), 8,
        f"разброс {p['cv']:.2f}")
    share = p["existing_payments"] / p["avg"] if p["avg"] else 1
    add("2.4", "Денежный поток", "Платежи по текущим кредитам", 8 if share == 0 else _band(share, [(0.10 + 1e-9, 7), (0.20, 5), (0.35, 2), (0, 0)]), 8,
        f"{share * 100:.0f} % поступлений")
    # 3. Кредитная история (30). Если БКИ недоступно — консервативно «нет КИ», итог помечается partial
    if not b or b["history_months"] == 0:
        s31, s32 = 6, 3
    else:
        s31 = {0: 12}.get(b["max_overdue_24m"]) or _band(b["max_overdue_24m"], [(1, 12), (8, 9), (31, 4), (60, 0), (0, 0)])
        s32 = _band(b["history_months"], [(12, 4), (36, 6), (0, 8)])
    add("3.1", "Кредитная история", "Просрочки за 24 мес.", s31, 12,
        "нет данных БКИ" if not b else ("нет просрочек" if b["max_overdue_24m"] == 0 else f"макс. {b['max_overdue_24m']} дн."))
    add("3.2", "Кредитная история", "Длина кредитной истории", s32, 8, "нет данных БКИ" if not b else f"{b['history_months']} мес.")
    add("3.3", "Кредитная история", "Обращения за кредитом (3 мес.)", _band(b["inquiries_3m"], [(3, 5), (6, 3), (0, 0)]) if b else 5, 5,
        "нет данных БКИ" if not b else str(b["inquiries_3m"]))
    add("3.4", "Кредитная история", "Действующие обязательства", _band(b["active_loans"], [(3, 5), (5, 3), (0, 0)]) if b else 5, 5,
        "нет данных БКИ" if not b else str(b["active_loans"]))
    # 4. Налоги и репутация (12)
    add("4.1", "Налоги и репутация", "Задолженность по налогам", 6 if p["tax_debt"] == 0 else 3 if (p["tax_debt"] <= 50_000 and p["tax_debt_days"] <= 30) else 0, 6,
        "нет" if p["tax_debt"] == 0 else f"{p['tax_debt']:,} ₽, {p['tax_debt_days']} дн.".replace(",", " "))
    cr = p["courts_ratio"]
    add("4.2", "Налоги и репутация", "Иски и исполнительные производства", 6 if cr == 0 else 4 if cr < 0.01 else 1 if cr < 0.05 else 0, 6,
        "нет" if cr == 0 else f"{cr * 100:.1f} % годового оборота")

    total = sum(f["points"] for f in F)
    return {"total": total, "grade": grade(total), "factors": F, "partial": not p["bureau_ok"]}


def grade(total: int) -> str:
    for g, cfg in policy()["pricing"]["grades"].items():
        if total >= cfg["min_score"]:
            return g
    return "E"


def pd_percent(total: int) -> float:
    """PD по методу PDO: 60 баллов = 5 %, +15 баллов удваивает шансы (только для документации/аудита)."""
    odds = 19 * 2 ** ((total - 60) / 15)
    return round(100 / (1 + odds), 1)


def pd_fraction(total: float) -> float:
    """PD (доля 0..1) по шкале PDO — тот же перевод баллов в вероятность, что и у ML-слоя."""
    return 1 / (1 + 19 * 2 ** ((total - 60) / 15))
