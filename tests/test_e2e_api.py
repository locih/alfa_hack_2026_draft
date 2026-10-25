"""Сквозные сценарии четырёх демо-клиентов через HTTP API (то же, что делает UI)."""
from conftest import login, submit


def get(api, h, app_id):
    r = api.get(f"/api/client/applications/{app_id}", headers=h)
    assert r.status_code == 200
    return r.json()


def test_client_a_happy_path_to_disbursement(api):
    h = login(api, "sever")
    app_id = submit(api, h)
    a = get(api, h, app_id)
    assert a["status"]["code"] == "OFFER_READY"
    assert a["offer"]["type"] == "AS_REQUESTED" and a["offer"]["rate"] == 18.0 and a["offer"]["payment"] == 149772
    assert api.post(f"/api/client/applications/{app_id}/accept", headers=h).status_code == 200
    a = get(api, h, app_id)
    assert a["status"]["code"] == "AWAITING_SIGNATURE" and a["sign_code"]
    bad = api.post(f"/api/client/applications/{app_id}/sign", headers=h, json={"code": "000000"})
    assert bad.status_code == 422
    ok = api.post(f"/api/client/applications/{app_id}/sign", headers=h, json={"code": a["sign_code"]})
    assert ok.status_code == 200
    a = get(api, h, app_id)
    assert a["status"]["code"] == "DISBURSED"
    assert a["contract"]["number"].startswith("КД-2026-") and len(a["schedule"]) == 24
    assert a["schedule"][-1]["balance"] == 0


def test_client_b_counter_offer_longer_term(api):
    h = login(api, "lesnoy")
    app_id = submit(api, h, amount=3_000_000, term=12)
    a = get(api, h, app_id)
    o = a["offer"]
    assert a["status"]["code"] == "OFFER_READY" and o["type"] == "COUNTER"
    assert (o["amount"], o["term"], o["rate"], o["payment"]) == (3_000_000, 24, 19.0, 151226)
    assert any(r["code"] == "R13" for r in a["reasons"])


def test_client_c_degradation_to_manual_review_then_docs_then_analyst(api):
    h = login(api, "gromov")
    app_id = submit(api, h, amount=400_000, term=12)
    assert get(api, h, app_id)["status"]["code"] == "MANUAL_REVIEW"       # БКИ недоступно → не отказ, а ручной разбор
    hb = login(api, "analyst")
    d = api.get(f"/api/bank/applications/{app_id}", headers=hb).json()
    assert d["can_decide"] and any("БКИ" in m for m in d["decision"]["manual_reasons"])
    assert api.post(f"/api/bank/applications/{app_id}/decision", headers=hb, json={"action": "request_docs"}).status_code == 422
    r = api.post(f"/api/bank/applications/{app_id}/decision", headers=hb,
                 json={"action": "request_docs", "comment": "Приложите выписку из другого банка"})
    assert r.status_code == 200
    assert get(api, h, app_id)["status"]["code"] == "AWAITING_DOCS"
    assert api.post(f"/api/client/applications/{app_id}/documents", headers=h, json={}).status_code == 200
    a = get(api, h, app_id)
    assert a["status"]["code"] == "OFFER_READY"                            # БКИ ответило после выписки, грейд C, 62 балла
    assert a["offer"]["rate"] == 20.5 and a["offer"]["payment"] == 37150


def test_client_c_analyst_approval_and_decline_paths(api):
    h, hb = login(api, "gromov"), login(api, "analyst")
    app_id = submit(api, h, amount=400_000, term=12)
    r = api.post(f"/api/bank/applications/{app_id}/decision", headers=hb, json={"action": "approve", "comment": "Выручка стабильна"})
    assert r.status_code == 200
    a = get(api, h, app_id)
    assert a["status"]["code"] == "OFFER_READY" and "analyst_approved" not in a["offer"]
    assert api.get(f"/api/bank/applications/{app_id}", headers=hb).json()["offer"]["analyst_approved"]
    # клиент отказывается от предложения → WITHDRAWN, затем можно подать новую
    assert api.post(f"/api/client/applications/{app_id}/decline-offer", headers=h).status_code == 200
    app2 = submit(api, h, amount=400_000, term=12)
    r = api.post(f"/api/bank/applications/{app2}/decision", headers=hb, json={"action": "decline"})
    assert r.status_code == 422                                             # причина обязательна
    r = api.post(f"/api/bank/applications/{app2}/decision", headers=hb, json={"action": "decline", "reasons": ["R02"]})
    assert r.status_code == 200 and get(api, h, app2)["status"]["code"] == "DECLINED"


def test_client_d_declined_with_stop_rule(api):
    h = login(api, "stroy")
    app_id = submit(api, h, amount=2_000_000, term=24)
    a = get(api, h, app_id)
    assert a["status"]["code"] == "DECLINED"
    assert a["reasons"][0]["code"] == "R07" and "налог" in a["reasons"][0]["text"].lower()
    hb = login(api, "analyst")
    d = api.get(f"/api/bank/applications/{app_id}", headers=hb).json()
    assert d["decision"]["stops"][0]["id"] == "H06"                         # скоринг при стоп-правиле не считается
    assert d["decision"].get("score") is None


def test_bureau_outage_mode_forces_manual_review(api):
    hadm, h = login(api, "admin"), login(api, "sever")
    api.post("/api/admin/settings", headers=hadm, json={"bureau_mode": "down"})
    app_id = submit(api, h)
    assert get(api, h, app_id)["status"]["code"] == "MANUAL_REVIEW"
    assert any("попытка 3 из 3" in e["message"] for e in api.get(f"/api/bank/applications/{app_id}", headers=hadm).json()["events"])


def test_access_control_and_isolation(api):
    h, h2, hb = login(api, "sever"), login(api, "lesnoy"), login(api, "analyst")
    app_id = submit(api, h)
    assert api.get(f"/api/client/applications/{app_id}", headers=h2).status_code == 404     # чужая заявка
    assert api.get("/api/bank/applications", headers=h).status_code == 403                   # клиент не видит кабинет банка
    assert api.get("/api/client/profile", headers=hb).status_code == 403
    assert api.get("/api/client/profile").status_code == 401
    assert api.post("/api/admin/reset", headers=hb).status_code == 403                       # аналитик не администратор


def test_idempotency_and_single_active_application(api):
    h = login(api, "lesnoy")
    body = {"product": "working", "amount": 1_000_000, "term": 12, "consents": {"pd": True, "bureau": True, "fns": True}}
    r1 = api.post("/api/client/applications", headers=h | {"Idempotency-Key": "k1"}, json=body)
    r2 = api.post("/api/client/applications", headers=h | {"Idempotency-Key": "k1"}, json=body)
    assert r1.json()["id"] == r2.json()["id"]
    r3 = api.post("/api/client/applications", headers=h, json=body)
    assert r3.status_code == 409


def test_validation_and_preferential_eligibility(api):
    h = login(api, "gromov")
    bad = {"product": "preferential", "amount": 600_000, "term": 12, "consents": {"pd": True, "bureau": True, "fns": True}}
    assert api.post("/api/client/applications", headers=h, json=bad).status_code == 422     # нет статуса приоритетной отрасли
    assert api.post("/api/client/applications", headers=h, json=bad | {"product": "working", "amount": 10}).status_code == 422
    assert api.post("/api/client/applications", headers=h, json=bad | {"product": "working", "consents": {"pd": True}}).status_code == 422


def test_quote_what_if_and_preapproval(api):
    h = login(api, "lesnoy")
    q = api.post("/api/client/quote", headers=h, json={"product": "working", "amount": 3_000_000, "term": 12}).json()
    assert q["fits"] is False and q["max_amount"] == 1_700_000 and q["rate"] == 18.5
    q = api.post("/api/client/quote", headers=h, json={"product": "working", "amount": 3_000_000, "term": 24}).json()
    assert q["fits"] is True and q["rate"] == 19.0
    pre = api.get("/api/client/profile", headers=h).json()["preapproval"]
    assert next(p for p in pre if p["product"] == "working")["available"]


def test_key_rate_parameter_changes_prices(api):
    hadm, h = login(api, "admin"), login(api, "sever")
    api.post("/api/admin/settings", headers=hadm, json={"key_rate": 16.0})
    a = get(api, h, submit(api, h))
    assert a["offer"]["rate"] == 20.0 and a["offer"]["key_rate_snapshot"] == 16.0


def test_events_are_split_by_visibility(api):
    h, hb = login(api, "gromov"), login(api, "analyst")
    app_id = submit(api, h, amount=400_000, term=12)
    client_ev = get(api, h, app_id)["events"]
    bank_ev = api.get(f"/api/bank/applications/{app_id}", headers=hb).json()["events"]
    assert len(bank_ev) > len(client_ev) and not any("БКИ:" in e["message"] for e in client_ev)


def test_client_payload_does_not_expose_internal_approval_path(api):
    """Клиент видит статус, следующий шаг и понятные причины — но не скоринг, стоп-правила, источники и внутренние статусы банка."""
    import json
    forbidden = ["H06", "H07", "scorecard", "grade", "afford", "enrichment", "decision", "БКИ", "скоринг", "stops", "p_max", "factors"]
    for user, kw in (("sever", {}), ("lesnoy", {"term": 12}), ("gromov", {"amount": 400_000, "term": 12}), ("stroy", {"amount": 2_000_000})):
        h = login(api, user)
        app_id = submit(api, h, **kw)
        a = get(api, h, app_id)
        blob = json.dumps(a, ensure_ascii=False)
        assert not [w for w in forbidden if w in blob], (user, [w for w in forbidden if w in blob])
        st = a["status"]
        assert st["next"] and st["need"] and st["eta"]                       # у каждого статуса есть «что дальше / что нужно / когда»
        if st["code"] == "MANUAL_REVIEW":                                    # не раскрываем, что именно не удалось получить
            assert [r["code"] for r in a["reasons"]] == ["R18"]
        api.post(f"/api/client/applications/{app_id}/withdraw", headers=h)


def test_preapproval_does_not_expose_internal_grade(api):
    h = login(api, "sever")
    pre = api.get("/api/client/profile", headers=h).json()["preapproval"]
    assert pre and all("grade" not in p for p in pre)


def test_static_assets_are_revalidated_not_cached(api):
    for path in ("/", "/app.js", "/style.css"):
        r = api.get(path)
        assert r.status_code == 200 and r.headers["cache-control"] == "no-cache" and r.headers.get("etag")


def test_collateral_options_are_named_by_legal_form(api):
    ooo = {o["id"]: o["label"] for o in api.get("/api/products", headers=login(api, "sever")).json()["products"][0]["collateral_options"]}
    ip = {o["id"]: o["label"] for o in api.get("/api/products", headers=login(api, "gromov")).json()["products"][0]["collateral_options"]}
    assert ooo["guarantor"] == "Поручительство собственников бизнеса" and ip["guarantor"] == "Поручительство третьего лица"
    assert ooo["none"] == "Без обеспечения" and "владельц" not in str(ooo) + str(ip)


def test_quote_shows_how_much_collateral_lowers_the_rate(api):
    h = login(api, "sever")
    base = {"product": "working", "amount": 1_000_000, "term": 24}
    none = api.post("/api/client/quote", headers=h, json=base).json()
    realty = api.post("/api/client/quote", headers=h, json=base | {"collateral": "realty"}).json()
    assert none["collateral_effect"] == 0 and realty["collateral_effect"] >= 2.0
    assert none["rate"] - realty["rate"] == realty["collateral_effect"] and realty["payment"] < none["payment"]


def _disburse(api, user="sever", amount=3_000_000, term=24):
    h = login(api, user)
    app_id = submit(api, h, amount=amount, term=term)
    api.post(f"/api/client/applications/{app_id}/accept", headers=h)
    code = get(api, h, app_id)["sign_code"]
    assert api.post(f"/api/client/applications/{app_id}/sign", headers=h, json={"code": code}).status_code == 200
    return h, app_id


def test_post_credit_loan_summary_and_payment_reduces_debt(api):
    h, app_id = _disburse(api)
    start = api.get("/api/client/account", headers=h).json()["balance"]
    assert start == 1_500_000 + 3_000_000                                      # стартовый остаток + зачисление кредита
    a = get(api, h, app_id)
    assert a["loan"]["outstanding"] == 3_000_000 and a["loan"]["paid_count"] == 0 and a["loan"]["next_payment"]["n"] == 1
    r = api.post(f"/api/client/applications/{app_id}/pay", headers=h)
    assert r.status_code == 200
    a = get(api, h, app_id)
    row1 = a["schedule"][0]
    assert row1["paid"] and not a["schedule"][1]["paid"]
    assert a["loan"]["outstanding"] == row1["balance"] < 3_000_000 and a["loan"]["paid_count"] == 1
    assert a["loan"]["interest_paid"] == row1["interest"] and a["loan"]["total_paid"] == row1["payment"]
    assert api.get("/api/client/account", headers=h).json()["balance"] == start - row1["payment"]
    assert a["status"]["code"] == "DISBURSED" and any("Платёж №1" in e["message"] for e in a["events"])   # статус заявки не меняется


def test_repay_whole_loan_and_insufficient_funds_flow(api):
    h, app_id = _disburse(api, "lesnoy")                                       # 0,5 + 3 млн ₽ на счёте, платежей на 3,63 млн ₽
    paid = 0
    while True:
        r = api.post(f"/api/client/applications/{app_id}/pay", headers=h)
        if r.status_code != 200:
            break
        paid += 1
    assert r.status_code == 422 and "Пополните счёт" in r.json()["detail"] and 0 < paid < 24
    assert api.post("/api/client/account/topup", headers=h, json={"amount": 500}).status_code == 422     # меньше минимума
    assert api.post("/api/client/account/topup", headers=h, json={"amount": 500_000}).status_code == 200
    while api.post(f"/api/client/applications/{app_id}/pay", headers=h).status_code == 200:
        pass
    a = get(api, h, app_id)
    assert a["loan"]["repaid"] and a["loan"]["outstanding"] == 0 and a["status"]["title"] == "Кредит погашен"
    assert all(r["paid"] for r in a["schedule"]) and a["schedule"][-1]["balance"] == 0
    assert api.post(f"/api/client/applications/{app_id}/pay", headers=h).status_code == 409


def test_schedule_dates_are_stable_after_disbursement_and_pay_is_private(api):
    h, app_id = _disburse(api)
    d1 = [r["date"] for r in get(api, h, app_id)["schedule"]]
    assert d1 == [r["date"] for r in get(api, h, app_id)["schedule"]]
    h2 = login(api, "lesnoy")
    assert api.post(f"/api/client/applications/{app_id}/pay", headers=h2).status_code == 404       # чужой кредит
    assert api.post(f"/api/client/applications/{app_id}/pay", headers=login(api, "analyst")).status_code == 403
    assert api.get("/api/client/account", headers=login(api, "analyst")).status_code == 403
