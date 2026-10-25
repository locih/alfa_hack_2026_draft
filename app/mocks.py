"""Моки внешних источников (БКИ, ЕГРЮЛ/ЕГРИП, ФНС «Прозрачный бизнес») и внутренних данных банка.

Все данные синтетические; ИНН с нереальным кодом региона «00». Каждый источник возвращает
{status: OK|UNAVAILABLE, fetched_at, data}. Недоступность источника не роняет заявку — она уходит на ручной разбор.
"""
import random
import time

from . import db

# Шаблон помесячных отклонений: нулевая сумма в каждой половине года → тренд задаётся параметром, а не шумом
_NOISE = [1.2, -0.8, 0.4, -1.2, 0.9, -0.5]
_NOISE_STD = 0.889


def _receipts(mean: float, growth: float, noise_cv: float) -> list[int]:
    """12 месяцев поступлений (тыс. → руб.): динамика «последние 6 / предыдущие 6» = growth, шум = noise_cv."""
    first = 2 * mean / (2 + growth)
    second = first * (1 + growth)
    out = []
    for half, level in ((_NOISE, first), (list(reversed(_NOISE)), second)):
        for d in half:
            out.append(round(level * (1 + noise_cv * d / _NOISE_STD)))
    return out


CLIENTS = {
    "C-A": {
        "id": "C-A", "start_balance": 1500000, "name": "ООО «Север-Тех»", "legal_form": "ООО", "inn": "0012345601", "ogrn": "1000000000011",
        "okved": "62.01 Разработка программного обеспечения", "industry": "it",
        "director": "Орлов Игорь Сергеевич", "address": "г. Северодвинск, ул. Синтетическая, 1",
        "registered": "2022-06-14", "age_months": 52, "tenure_months": 30,
        "account": "40702810000000000011", "tax_regime": "УСН",
        "receipts": _receipts(4_200_000, 0.12, 0.12), "existing_payments": 250_000,
        "statement_source": "bank", "statement_months": 12,
        "bureau": {"history_months": 60, "max_overdue_24m": 0, "current_overdue_days": 0, "inquiries_3m": 1, "active_loans": 1},
        "fns": {"tax_debt": 0, "tax_debt_days": 0, "courts_ratio": 0.0, "sanctions": False, "blocked": False},
        "egrul": {"status": "active", "unreliable": False, "disqualified": False},
        "msp_registry": True, "priority_industry": True,
    },
    "C-B": {
        "id": "C-B", "start_balance": 500000, "name": "ООО «Лесной хлеб»", "legal_form": "ООО", "inn": "0012345602", "ogrn": "1000000000022",
        "okved": "10.71 Производство хлеба и мучных кондитерских изделий", "industry": "production",
        "director": "Лесникова Марина Петровна", "address": "г. Вологда, ул. Демонстрационная, 7",
        "registered": "2025-02-03", "age_months": 20, "tenure_months": 10,
        "account": "40702810000000000022", "tax_regime": "УСН",
        "receipts": _receipts(3_000_000, 0.04, 0.40), "existing_payments": 120_000,
        "statement_source": "other", "statement_months": 12,
        "bureau": {"history_months": 28, "max_overdue_24m": 3, "current_overdue_days": 0, "inquiries_3m": 3, "active_loans": 2},
        "fns": {"tax_debt": 0, "tax_debt_days": 0, "courts_ratio": 0.0, "sanctions": False, "blocked": False},
        "egrul": {"status": "active", "unreliable": False, "disqualified": False},
        "msp_registry": True, "priority_industry": True,
    },
    "C-C": {
        "id": "C-C", "start_balance": 80000, "name": "ИП Громов А. С.", "legal_form": "ИП", "inn": "001234560003", "ogrn": "300000000000033",
        "okved": "56.10 Рестораны и услуги по доставке продуктов питания", "industry": "catering",
        "director": "Громов Алексей Сергеевич", "address": "г. Тверь, ул. Тестовая, 12",
        "registered": "2025-11-20", "age_months": 11, "tenure_months": 3,
        "account": "40802810000000000033", "tax_regime": "Патент",
        "receipts": _receipts(900_000, -0.05, 0.58), "existing_payments": 0,
        "statement_source": "none", "statement_months": 0,
        "bureau": {"history_months": 8, "max_overdue_24m": 0, "current_overdue_days": 0, "inquiries_3m": 1, "active_loans": 0},
        "bureau_requires_statement": True,        # демо: БКИ «отвечает» только после загрузки выписки
        "fns": {"tax_debt": 0, "tax_debt_days": 0, "courts_ratio": 0.0, "sanctions": False, "blocked": False},
        "egrul": {"status": "active", "unreliable": False, "disqualified": False},
        "msp_registry": True, "priority_industry": False,
    },
    "C-D": {
        "id": "C-D", "start_balance": 200000, "name": "ООО «СтройРесурс»", "legal_form": "ООО", "inn": "0012345604", "ogrn": "1000000000044",
        "okved": "41.20 Строительство жилых и нежилых зданий", "industry": "construction",
        "director": "Строев Виктор Андреевич", "address": "г. Калуга, ул. Образцовая, 20",
        "registered": "2023-04-10", "age_months": 36, "tenure_months": 24,
        "account": "40702810000000000044", "tax_regime": "ОСНО",
        "receipts": _receipts(2_400_000, -0.08, 0.30), "existing_payments": 180_000,
        "statement_source": "bank", "statement_months": 12,
        "bureau": {"history_months": 40, "max_overdue_24m": 5, "current_overdue_days": 0, "inquiries_3m": 2, "active_loans": 2},
        "fns": {"tax_debt": 380_000, "tax_debt_days": 75, "courts_ratio": 0.02, "sanctions": False, "blocked": False},
        "egrul": {"status": "active", "unreliable": False, "disqualified": False},
        "msp_registry": True, "priority_industry": False,
    },
}


def get_client(client_id: str) -> dict:
    return CLIENTS[client_id]


class Unavailable(Exception):
    pass


def bureau(client: dict, statement_uploaded: bool, mode: str) -> dict:
    if mode == "down":
        raise Unavailable("БКИ: сервис не отвечает (режим стенда «сбой»)")
    if client.get("bureau_requires_statement") and not statement_uploaded:
        raise Unavailable("БКИ: таймаут запроса")
    return client["bureau"]


def egrul(client: dict) -> dict:
    return {"inn": client["inn"], "ogrn": client["ogrn"], "name": client["name"], "okved": client["okved"],
            "director": client["director"], "address": client["address"], "registered": client["registered"],
            "age_months": client["age_months"], **client["egrul"]}


def fns(client: dict) -> dict:
    return dict(client["fns"], msp_registry=client["msp_registry"], priority_industry=client["priority_industry"])


def bank_data(client: dict, statement_uploaded: bool) -> dict:
    src, months = client["statement_source"], client["statement_months"]
    if src == "none" and statement_uploaded:
        src, months = "other", 12
    return {"receipts": client["receipts"], "existing_payments": client["existing_payments"],
            "tenure_months": client["tenure_months"], "statement_source": src, "statement_months": months,
            "account": client["account"]}


def collect(client: dict, statement_uploaded: bool, bureau_mode: str, retries: int = 2, backoff: float = 0.0) -> tuple[dict, list[str]]:
    """Собирает данные из всех источников. Возвращает (enrichment, строки журнала для банка)."""
    log: list[str] = []
    out = {"egrul": {"status": "OK", "fetched_at": db.now(), "data": egrul(client)},
           "fns": {"status": "OK", "fetched_at": db.now(), "data": fns(client)},
           "bank": {"status": "OK", "fetched_at": db.now(), "data": bank_data(client, statement_uploaded)}}
    log.append("ЕГРЮЛ/ЕГРИП: OK")
    log.append("ФНС «Прозрачный бизнес»: OK")
    log.append("Внутренние данные банка (обороты за 12 мес.): OK")
    for attempt in range(1, retries + 2):
        try:
            data = bureau(client, statement_uploaded, bureau_mode)
            out["bureau"] = {"status": "OK", "fetched_at": db.now(), "data": data}
            log.append("БКИ: OK")
            break
        except Unavailable as e:
            log.append(f"{e}; попытка {attempt} из {retries + 1}")
            if backoff > 0 and attempt <= retries:               # экспоненциальная пауза с джиттером между повторами
                time.sleep(backoff * 2 ** (attempt - 1) * (0.5 + random.random()))
    else:
        out["bureau"] = {"status": "UNAVAILABLE", "fetched_at": db.now(), "data": None}
    return out, log
