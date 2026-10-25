"""Регрессионные тесты по замечаниям код-ревью (цикл 1): каждый тест воспроизводит найденный баг."""
import json

import pytest
from conftest import login, submit

from app import db, pd_provider, service
from app import policy as pol
from app.pd_provider import PDProvider


def get(api, h, app_id):
    return api.get(f"/api/client/applications/{app_id}", headers=h).json()


def disburse(api, user="sever", **kw):
    h = login(api, user)
    app_id = submit(api, h, **kw)
    api.post(f"/api/client/applications/{app_id}/accept", headers=h)
    code = get(api, h, app_id)["sign_code"]
    assert api.post(f"/api/client/applications/{app_id}/sign", headers=h, json={"code": code}).status_code == 200
    return h, app_id


def test_legacy_contract_without_payment_fields_can_be_paid(api):
    """Кредит, выданный до модуля платежей: у договора нет payments / repaid / schedule_start."""
    h, app_id = disburse(api)
    with db.tx() as c:
        row = c.execute("SELECT contract FROM applications WHERE id=?", (app_id,)).fetchone()
        ct = json.loads(row["contract"])
        for k in ("payments", "repaid", "schedule_start"):
            ct.pop(k)
        c.execute("UPDATE applications SET contract=? WHERE id=?", (json.dumps(ct), app_id))
    dates = [r["date"] for r in get(api, h, app_id)["schedule"]]
    assert api.post(f"/api/client/applications/{app_id}/pay", headers=h).status_code == 200    # раньше: KeyError → 500
    a = get(api, h, app_id)
    assert a["loan"]["paid_count"] == 1 and [r["date"] for r in a["schedule"]] == dates          # даты привязаны к дате договора


@pytest.mark.parametrize("body,code", [
    ({"product": "working", "amount": 1_000_000, "term": 1_000_000_000}, 422),     # Field(le=600) — раньше строился график на 10^9 строк
    ({"product": "working", "amount": 1_000_000, "term": 120}, 422),               # вне границ продукта
    ({"product": "working", "amount": 10, "term": 12}, 422),
    ({"product": "working", "amount": 1_000_000, "term": 12, "collateral": "yacht"}, 422),
    ({"product": "nope", "amount": 1_000_000, "term": 12}, 422),
    ({"product": "working", "amount": 1_000_000, "term": 12}, 200),
])
def test_quote_validates_like_application(api, body, code):
    assert api.post("/api/client/quote", headers=login(api, "sever"), json=body).status_code == code


def test_quote_preferential_is_closed_for_ineligible_client(api):
    r = api.post("/api/client/quote", headers=login(api, "gromov"), json={"product": "preferential", "amount": 600_000, "term": 12})
    assert r.status_code == 422


def test_pipeline_crash_degrades_to_manual_review_with_bank_log(api, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("сбой модели")
    monkeypatch.setattr(pol, "evaluate", boom)
    h, hb = login(api, "sever"), login(api, "analyst")
    app_id = submit(api, h)
    assert get(api, h, app_id)["status"]["code"] == "MANUAL_REVIEW"                       # раньше: вечное «Проверяем данные»
    bank = api.get(f"/api/bank/applications/{app_id}", headers=hb).json()
    assert any("Сбой автоматической обработки" in e["message"] and e["vis"] == "bank" for e in bank["events"])
    assert not any("Сбой" in e["message"] for e in get(api, h, app_id)["events"])           # клиенту детали сбоя не показываем
    assert bank["can_decide"] and any("RuntimeError" in m for m in bank["decision"]["manual_reasons"])


def test_pending_applications_resume_after_restart(api, monkeypatch):
    monkeypatch.setattr(service, "kick", lambda app_id: None)                             # «процесс умер» сразу после создания заявки
    h = login(api, "sever")
    app_id = submit(api, h)
    assert get(api, h, app_id)["status"]["code"] == "VERIFICATION"
    monkeypatch.undo()
    assert service.resume_pending() == 1
    assert get(api, h, app_id)["status"]["code"] == "OFFER_READY"


def test_overdraft_limit_is_not_credited_to_account_as_cash(api):
    h, app_id = disburse(api, product="overdraft", amount=1_000_000, term=12)
    a = get(api, h, app_id)
    assert a["status"]["code"] == "DISBURSED" and a["loan"] is None and a["schedule"] is None
    assert api.get("/api/client/account", headers=h).json()["balance"] == 1_500_000        # баланс не изменился
    assert any("Лимит овердрафта открыт" in e["message"] for e in a["events"])
    assert api.post(f"/api/client/applications/{app_id}/pay", headers=h).status_code == 409


def test_wrong_sign_code_attempt_is_persisted_and_expired_offer_is_reported(api):
    h = login(api, "sever")
    app_id = submit(api, h)
    api.post(f"/api/client/applications/{app_id}/accept", headers=h)
    assert api.post(f"/api/client/applications/{app_id}/sign", headers=h, json={"code": "000000"}).status_code == 422
    assert any(e["message"] == "Неверный код подтверждения" for e in get(api, h, app_id)["events"])   # раньше откатывалось вместе с транзакцией
    # просроченная оферта: ошибка клиенту И переход в EXPIRED сохранён
    h2 = login(api, "lesnoy")
    app2 = submit(api, h2, term=12)
    with db.tx() as c:
        offer = json.loads(c.execute("SELECT offer FROM applications WHERE id=?", (app2,)).fetchone()["offer"])
        offer["valid_until"] = "2020-01-01T00:00:00+00:00"
        c.execute("UPDATE applications SET offer=? WHERE id=?", (json.dumps(offer), app2))
    r = api.post(f"/api/client/applications/{app2}/accept", headers=h2)
    assert r.status_code == 409 and "истёк" in r.json()["detail"]
    assert get(api, h2, app2)["status"]["code"] == "EXPIRED"


def test_analyst_cannot_approve_more_than_requested(api):
    h, hb = login(api, "gromov"), login(api, "analyst")
    app_id = submit(api, h, amount=400_000, term=12)                                       # → ручной разбор (БКИ)
    r = api.post(f"/api/bank/applications/{app_id}/decision", headers=hb, json={"action": "approve", "amount": 5_000_000, "comment": "ок"})
    assert r.status_code == 422 and "больше" in r.json()["detail"]
    r = api.post(f"/api/bank/applications/{app_id}/decision", headers=hb, json={"action": "approve", "amount": 300_000, "term": 12})
    assert r.status_code == 200


def test_shap_contributions_are_computed_once_per_cascade_decision(api):
    """Вклады признаков нужны только для итогового предложения, а не для каждого промежуточного predict."""
    from app import cascade, mocks
    from ml import features as F

    class StubModel:
        version, meta = "stub-1", {}

        def __init__(self):
            self.predicts = self.explains = 0

        def predict_pd(self, feats):
            self.predicts += 1
            return 0.02 if feats["term"] <= 12 else 0.03

        def explain(self, feats, top=5):
            self.explains += 1
            return [("receipts_cv", 0.3)]

    m = StubModel()
    cl = mocks.get_client("C-B")
    enr, _ = mocks.collect(cl, True, "ok")
    d = cascade.evaluate_cascade(dict(product="working", amount=3_000_000, term=12, collateral="none"), cl, enr, 14.0, provider=PDProvider(m))
    assert d["outcome"] == "counter" and m.predicts >= 3 and m.explains == 1
    assert d["ml"]["contributions"] == [{"feature": "receipts_cv", "value": 0.3}]


def test_pdo_scale_has_one_source_of_truth():
    from app import scoring
    from ml.predict import pd_to_score
    from ml.scale import score_to_pd
    for s in (35, 50, 60, 74, 95):
        assert scoring.pd_fraction(s) == score_to_pd(s) and abs(pd_to_score(score_to_pd(s)) - s) < 1e-6
    assert scoring.pd_percent(60) == 5.0



# ---------- цикл 2 ----------

def test_downsell_recommendation_carries_product_title_for_the_analyst(api, monkeypatch):
    from test_cascade import FakePD
    monkeypatch.setattr(pd_provider, "get_provider", lambda: FakePD({"working": 15.0, "overdraft": 9.0}))   # у овердрафта серая зона → человек
    hadm, h = login(api, "admin"), login(api, "sever")
    api.post("/api/admin/settings", headers=hadm, json={"decision_mode": "ml_cascade"})
    app_id = submit(api, h, amount=3_000_000, term=12)
    rec = api.get(f"/api/bank/applications/{app_id}", headers=hadm).json()["decision"]["recommendation"]
    assert rec["type"] == "DOWNSELL" and rec["product"] == "overdraft" and rec["product_title"] == "Овердрафт"


def test_pipeline_failure_does_not_claim_that_bureau_data_was_received(api, monkeypatch):
    hadm, h = login(api, "admin"), login(api, "sever")
    api.post("/api/admin/settings", headers=hadm, json={"bureau_mode": "down"})
    monkeypatch.setattr(pol, "evaluate", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("сбой")))
    app_id = submit(api, h)
    dec = api.get(f"/api/bank/applications/{app_id}", headers=hadm).json()["decision"]
    assert dec["outcome"] == "manual" and "bureau_ok" not in dec                      # раньше принудительно bureau_ok=True


def test_account_read_does_not_take_a_write_lock_once_row_exists(api, monkeypatch):
    first = service.account_view("C-A")["balance"]
    def no_write(*a, **k):
        raise AssertionError("GET счёта не должен открывать запись")
    monkeypatch.setattr(db, "tx", no_write)
    assert service.account_view("C-A")["balance"] == first


def test_lists_are_light_but_keep_everything_the_screens_need(api):
    assert "enrichment" not in service._LIST_COLS and "offer" not in service._LIST_COLS and "consents" not in service._LIST_COLS
    h, hb = login(api, "gromov"), login(api, "analyst")
    app_id = submit(api, h, amount=400_000, term=12)
    api.post(f"/api/bank/applications/{app_id}/decision", headers=hb, json={"action": "request_docs", "comment": "Нужна выписка за год"})
    row = api.get("/api/client/applications", headers=h).json()[0]
    assert row["status"]["code"] == "AWAITING_DOCS" and "Нужна выписка за год" in row["status"]["text"]      # doc_request попал в список
    brow = next(r for r in api.get("/api/bank/applications", headers=hb).json() if r["id"] == app_id)
    assert brow["score"] is not None and brow["grade"] and brow["status"] == "AWAITING_DOCS"


def test_failed_begin_does_not_mask_the_original_error(monkeypatch):
    import sqlite3

    class LockedConn:
        in_transaction = False

        def execute(self, sql, *a):
            assert sql != "ROLLBACK", "ROLLBACK без активной транзакции маскирует исходную ошибку"
            raise sqlite3.OperationalError("database is locked")

        def close(self):
            pass

    monkeypatch.setattr(db, "connect", lambda: LockedConn())
    with pytest.raises(sqlite3.OperationalError, match="database is locked"):
        with db.tx():
            pass


# ---------- цикл 3 ----------

def test_text_inputs_are_size_limited(api):
    h, hb = login(api, "sever"), login(api, "analyst")
    base = {"product": "working", "amount": 1_000_000, "term": 12, "consents": {"pd": True, "bureau": True, "fns": True}}
    assert api.post("/api/client/applications", headers=h, json=base | {"purpose_text": "я" * 501}).status_code == 422
    assert api.post("/api/client/applications", headers=h, json=base | {"purpose": "x" * 41}).status_code == 422
    assert api.post("/api/client/applications", headers=h, json=base | {"purpose_text": "я" * 500}).status_code == 201
    assert api.post("/api/bank/applications/ALF-000001/decision", headers=hb, json={"action": "request_docs", "comment": "я" * 1001}).status_code == 422
    assert api.post("/api/bank/applications/ALF-000001/decision", headers=hb, json={"action": "decline", "reasons": ["R02"] * 21}).status_code == 422


def test_login_is_throttled_before_password_hashing(api, monkeypatch):
    from app import main
    calls = {"n": 0}
    real = db.hash_pw
    monkeypatch.setattr(db, "hash_pw", lambda *a: (calls.__setitem__("n", calls["n"] + 1), real(*a))[1])
    for _ in range(main.LOGIN_MAX_FAILS):
        assert api.post("/api/auth/login", json={"login": "admin", "password": "bad"}).status_code == 401
    hashed = calls["n"]
    r = api.post("/api/auth/login", json={"login": "admin", "password": "demo123"})
    assert r.status_code == 429 and calls["n"] == hashed                                  # перебор не нагружает PBKDF2
    assert api.post("/api/auth/login", json={"login": "sever", "password": "demo123"}).status_code == 200   # другой логин не пострадал
    t0 = main._now()
    monkeypatch.setattr(main, "_now", lambda: t0 + main.LOGIN_WINDOW_S + 1)                 # окно прошло
    assert api.post("/api/auth/login", json={"login": "admin", "password": "demo123"}).status_code == 200


def test_successful_login_resets_failure_counter(api):
    from app import main
    for _ in range(main.LOGIN_MAX_FAILS - 1):
        api.post("/api/auth/login", json={"login": "sever", "password": "bad"})
    assert api.post("/api/auth/login", json={"login": "sever", "password": "demo123"}).status_code == 200
    for _ in range(main.LOGIN_MAX_FAILS - 1):
        assert api.post("/api/auth/login", json={"login": "sever", "password": "bad"}).status_code == 401


def test_demo_users_endpoint_can_be_disabled(api, monkeypatch):
    assert api.get("/api/auth/demo-users").status_code == 200
    monkeypatch.setenv("DEMO_MODE", "0")
    assert api.get("/api/auth/demo-users").status_code == 404
    assert api.post("/api/auth/login", json={"login": "sever", "password": "demo123"}).status_code == 200       # вход по паролю работает


def test_bureau_retries_use_exponential_backoff_with_jitter(monkeypatch):
    from app import mocks
    sleeps = []
    monkeypatch.setattr(mocks.time, "sleep", sleeps.append)
    enr, log = mocks.collect(mocks.get_client("C-A"), False, "down", retries=2, backoff=0.2)
    assert enr["bureau"]["status"] == "UNAVAILABLE" and len(sleeps) == 2                    # между тремя попытками две паузы
    assert 0.1 <= sleeps[0] <= 0.3 and 0.2 <= sleeps[1] <= 0.6 and sleeps[1] > sleeps[0] * 0.9
    sleeps.clear()
    mocks.collect(mocks.get_client("C-A"), False, "down", retries=2)                          # backoff=0 → без пауз (тесты и режим STEP_DELAY_SEC=0)
    assert sleeps == []


def test_grade_does_not_depend_on_yaml_key_order(monkeypatch):
    from app import scoring
    from app.config import policy
    grades = policy()["pricing"]["grades"]
    monkeypatch.setitem(policy()["pricing"], "grades", dict(reversed(list(grades.items()))))   # E, D, C, B, A
    assert [scoring.grade(s) for s in (95, 80, 79, 65, 50, 35, 34, 0)] == ["A", "A", "B", "B", "C", "D", "E", "E"]


def test_no_credit_history_is_not_shown_as_no_overdue(api):
    from app import mocks, scoring
    cl = mocks.get_client("C-A")
    enr, _ = mocks.collect(cl, False, "ok")
    p = scoring.build_profile(cl, enr)
    p["bureau"] = dict(p["bureau"], history_months=0)
    f = {x["id"]: x for x in scoring.score(p)["factors"]}
    assert f["3.1"]["value"] == "нет кредитной истории" and f["3.2"]["value"] == "нет кредитной истории" and f["3.1"]["points"] == 6
