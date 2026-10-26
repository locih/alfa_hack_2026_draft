"""Каскад по продуктам на PD: логика зон и маршрутов проверяется на подставном провайдере (ML-библиотеки не нужны)."""
import math

import pytest
from conftest import login, submit

from app import cascade, mocks, pd_provider, scoring
from app.config import policy
from app.pd_provider import PDProvider, PDResult
from ml import features as F
from ml.predict import pd_to_score


class FakePD:
    """PD по продуктам задаётся функцией; считает вызовы."""
    def __init__(self, table):
        self.table, self.calls = table, []

    def predict(self, profile, *, product, amount, term, collateral, legal_form):
        self.calls.append(product)
        v = self.table(product) if callable(self.table) else self.table[product]
        return PDResult(v / 100, "ml", "fake-1", [("receipts_cv", 0.4), ("bureau_inquiries_3m", 0.2), ("avg_receipts_log", -0.3)], {})

    def status(self):
        return {"source": "ml", "version": "fake-1"}


def run(cid, provider, product="working", amount=3_000_000, term=24, collateral="none", bureau="ok", stmt=False):
    cl = mocks.get_client(cid)
    enr, _ = mocks.collect(cl, stmt, bureau)
    app = dict(product=product, amount=amount, term=term, collateral=collateral)
    return cascade.evaluate_cascade(app, cl, enr, 14.0, provider=provider)


@pytest.fixture()
def cfg():
    c = policy()["ml"]
    saved = c["grey_zone"]
    yield c
    c["grey_zone"] = saved


def test_cutoffs_are_consistent():
    c = policy()["ml"]
    for prod, v in c["cutoffs"].items():
        assert 0 < v["approve"] < v["decline"] < 100, prod
    g = c["grade_pd_cutoffs"]
    assert g["A"] < g["B"] < g["C"] < g["D"]
    assert set(c["cutoffs"]) == set(policy()["products"]) == set(c["ladder"])
    for prod, lower in c["ladder"].items():
        assert prod not in lower and set(lower) <= set(c["cutoffs"])


@pytest.mark.parametrize("pd,zone", [(1.0, "approve"), (5.0, "approve"), (5.1, "grey"), (11.9, "grey"), (12.0, "skip"), (30, "skip")])
def test_zone_boundaries_working(pd, zone):
    assert cascade.zone_of("working", pd) == zone


@pytest.mark.parametrize("pd,grade", [(0.5, "A"), (2.0, "A"), (2.1, "B"), (4.0, "B"), (5.0, "C"), (8.0, "D"), (14.2, "D"), (14.3, "E")])
def test_grade_from_pd(pd, grade):
    assert cascade.grade_from_pd(pd) == grade


def test_low_pd_auto_approves_requested_product():
    f = FakePD({"working": 1.0, "overdraft": 1.0})
    d = run("C-A", f)
    assert d["outcome"] == "approve" and d["recommendation"]["product"] == "working" and d["recommendation"]["type"] == "AS_REQUESTED"
    assert f.calls == ["working", "working"]                       # дальше по каскаду не идём
    assert d["ml"]["trace"][0]["zone"] == "approve" and d["ml"]["source"] == "ml"


def test_skip_requested_then_safer_product_auto_approves_as_downsell():
    f = FakePD({"working": 15.0, "overdraft": 3.0})
    d = run("C-A", f)
    assert d["outcome"] == "counter" and d["recommendation"]["type"] == "DOWNSELL" and d["recommendation"]["product"] == "overdraft"
    assert [t["zone"] for t in d["ml"]["trace"]] == ["skip", "approve"]
    assert d["reasons"][0]["code"] == "R20"


def test_grey_zone_tries_safer_product_before_human(cfg):
    cfg["grey_zone"] = "downsell_then_refer"
    f = FakePD({"development": 5.0, "working": 3.0, "overdraft": 3.0})                 # development: серая зона (3–9)
    d = run("C-A", f, product="development", amount=3_000_000, term=36, collateral="equipment")
    assert d["outcome"] == "counter" and d["recommendation"]["product"] == "working" and d["recommendation"]["type"] == "DOWNSELL"
    assert [t["zone"] for t in d["ml"]["trace"]] == ["grey", "approve"]


def test_grey_zone_goes_to_human_when_no_safe_alternative(cfg):
    cfg["grey_zone"] = "downsell_then_refer"
    f = FakePD({"development": 5.0, "working": 8.0, "overdraft": 9.0})                  # у альтернатив тоже серая зона
    d = run("C-A", f, product="development", amount=3_000_000, term=36, collateral="equipment")
    assert d["outcome"] == "manual" and d["recommendation"]["product"] == "development"
    assert any("серая зона" in m for m in d["manual_reasons"])
    assert len(d["ml"]["trace"]) == 3                                                   # прошли весь каскад


def test_refer_mode_sends_grey_zone_straight_to_human(cfg):
    cfg["grey_zone"] = "refer"
    f = FakePD({"development": 5.0, "working": 1.0, "overdraft": 1.0})
    d = run("C-A", f, product="development", amount=3_000_000, term=36, collateral="equipment")
    assert d["outcome"] == "manual" and len(d["ml"]["trace"]) == 1


def test_all_products_skipped_declines():
    f = FakePD(lambda p: 25.0)
    d = run("C-B", f)
    assert d["outcome"] == "decline" and d["stage"] == "cascade" and d["reasons"][0]["code"] == "R02"
    assert len(d["ml"]["trace"]) == 2                                                   # working → overdraft


def test_bureau_outage_forces_human_even_with_tiny_pd():
    d = run("C-C", FakePD(lambda p: 0.5), amount=400_000, term=12)
    assert d["outcome"] == "manual" and "Данные БКИ недоступны" in d["manual_reasons"]


def test_stop_rules_run_before_the_model():
    f = FakePD(lambda p: 0.5)
    d = run("C-D", f, amount=2_000_000)
    assert d["outcome"] == "decline" and d["stage"] == "stop-rule" and d["stops"][0]["id"] == "H06"
    assert f.calls == []                                                                # модель не вызывалась


def test_counter_offer_inside_cascade_keeps_dscr_logic():
    d = run("C-B", FakePD(lambda p: 2.0), amount=3_000_000, term=12)
    r = d["recommendation"]
    assert d["outcome"] == "counter" and r["type"] == "COUNTER" and (r["amount"], r["term"]) == (3_000_000, 24)
    assert r["payment"] <= d["afford"]["p_max"] + 1


def test_ml_contributions_drive_hurting_reasons():
    d = run("C-B", FakePD(lambda p: 2.0), amount=3_000_000, term=12)
    codes = [r["code"] for r in d["reasons"]]
    assert "R13" in codes and "R10" in codes and "R06" in codes                         # cv → R10, inquiries → R06 (вклады > 0)
    assert "R02" not in codes[1:]                                                       # отрицательный вклад не объясняет отказ


def test_scorecard_fallback_provider_matches_rules_outcomes():
    prov = PDProvider(model=None)
    assert prov.status()["source"] == "scorecard"
    assert run("C-A", prov)["outcome"] == "approve"
    d = run("C-B", prov, amount=3_000_000, term=12)
    assert d["outcome"] == "counter" and d["recommendation"]["term"] == 24 and d["ml"]["source"] == "scorecard"
    assert run("C-D", prov, amount=2_000_000)["outcome"] == "decline"
    assert run("C-C", prov, amount=400_000, term=12)["outcome"] == "manual"


def test_score_scale_roundtrip():
    for s in (35, 50, 65, 74, 80, 95):
        assert abs(pd_to_score(scoring.pd_fraction(s)) - s) < 0.01


# ---------- признаки ----------

def _profile(cid="C-B", bureau_ok=True):
    cl = mocks.get_client(cid)
    enr, _ = mocks.collect(cl, False, "ok" if bureau_ok else "down")
    return cl, scoring.build_profile(cl, enr)


def test_feature_vector_is_complete_and_stable():
    cl, p = _profile()
    f = F.build(p, product="working", kind="annuity", amount=3_000_000, term=24, collateral="none", legal_form=cl["legal_form"], ncf_margin=0.12)
    assert set(F.FEATURES) <= set(f) and len(F.encode(f)) == len(F.FEATURES) == len(F.MONOTONE)
    assert len(F.schema_hash()) == 12 and F.schema_hash() == F.schema_hash()
    assert all(m == 0 for name, m in zip(F.FEATURES, F.MONOTONE) if name in F.CATEGORICAL)


def test_missing_bureau_becomes_nan_not_zero():
    cl, p = _profile("C-C", bureau_ok=False)
    f = F.build(p, product="working", kind="annuity", amount=400_000, term=12, collateral="none", legal_form="ИП", ncf_margin=0.08)
    assert f["bureau_available"] == 0.0 and math.isnan(f["bureau_max_overdue_24m"])
    enc = dict(zip(F.FEATURES, F.encode(f)))
    assert math.isnan(enc["bureau_history_months"]) and enc["product"] == 0.0


def test_unknown_category_encodes_as_missing():
    enc = dict(zip(F.FEATURES, F.encode({"product": "crypto-loan"})))
    assert math.isnan(enc["product"])


# ---------- через API: режим решения переключается в пульте ----------

def test_api_ml_cascade_mode_end_to_end(api, monkeypatch, tmp_path):
    monkeypatch.setenv("MODEL_DIR", str(tmp_path / "no_model"))      # тест запасного режима не зависит от models/
    pd_provider.reset_provider()
    hadm, h = login(api, "admin"), login(api, "lesnoy")
    s = api.post("/api/admin/settings", headers=hadm, json={"decision_mode": "ml_cascade"}).json()
    assert s["decision_mode"] == "ml_cascade" and s["ml"]["source"] == "scorecard"       # модели нет → запасной режим
    app_id = submit(api, h, amount=3_000_000, term=12)
    a = api.get(f"/api/client/applications/{app_id}", headers=h).json()
    assert a["status"]["code"] == "OFFER_READY" and a["offer"]["term"] == 24 and a["offer"]["product_title"]
    d = api.get(f"/api/bank/applications/{app_id}", headers=hadm).json()["decision"]
    assert d["mode"] == "ml_cascade" and d["ml"]["trace"] and d["ml"]["source"] == "scorecard" and d["pd"] is not None


def test_api_downsell_offer_is_accepted_and_disbursed(api, monkeypatch):
    fake = FakePD({"working": 15.0, "overdraft": 3.0})
    monkeypatch.setattr(pd_provider, "get_provider", lambda: fake)
    hadm, h = login(api, "admin"), login(api, "sever")
    api.post("/api/admin/settings", headers=hadm, json={"decision_mode": "ml_cascade"})
    app_id = submit(api, h, amount=3_000_000, term=12)
    a = api.get(f"/api/client/applications/{app_id}", headers=h).json()
    assert a["offer"]["type"] == "DOWNSELL" and a["offer"]["product"] == "overdraft" and a["product"] == "working"
    assert api.post(f"/api/client/applications/{app_id}/accept", headers=h).status_code == 200
    code = api.get(f"/api/client/applications/{app_id}", headers=h).json()["sign_code"]
    assert api.post(f"/api/client/applications/{app_id}/sign", headers=h, json={"code": code}).status_code == 200
    done = api.get(f"/api/client/applications/{app_id}", headers=h).json()
    assert done["status"]["code"] == "DISBURSED" and done["contract"]["amount"] == a["offer"]["amount"]


def test_api_analyst_can_approve_recommended_product_in_manual_review(api, monkeypatch):
    fake = FakePD({"working": 15.0, "overdraft": 9.0})                                   # у overdraft серая зона → человек
    monkeypatch.setattr(pd_provider, "get_provider", lambda: fake)
    hadm, h = login(api, "admin"), login(api, "sever")
    api.post("/api/admin/settings", headers=hadm, json={"decision_mode": "ml_cascade"})
    app_id = submit(api, h, amount=3_000_000, term=12)
    assert api.get(f"/api/client/applications/{app_id}", headers=h).json()["status"]["code"] == "MANUAL_REVIEW"
    rec = api.get(f"/api/bank/applications/{app_id}", headers=hadm).json()["decision"]["recommendation"]
    assert rec["product"] == "overdraft"
    assert api.post(f"/api/bank/applications/{app_id}/decision", headers=hadm, json={"action": "approve"}).status_code == 200
    offer = api.get(f"/api/client/applications/{app_id}", headers=h).json()["offer"]
    assert offer["product"] == "overdraft" and offer["type"] == "DOWNSELL"


def test_grade_flip_between_iterations_converges_and_keeps_counter_type():
    """PD зависит от срока: при 12 мес. — грейд A, при 24 мес. — B. Предложение пересчитывается от исходного запроса с худшим грейдом."""
    class TermPD(FakePD):
        def predict(self, profile, *, product, amount, term, collateral, legal_form):
            self.calls.append((product, term))
            return PDResult((1.5 if term <= 12 else 3.0) / 100, "ml", "fake-2", [("receipts_cv", 0.4)], {})

    d = run("C-B", TermPD({}), amount=3_000_000, term=12)
    r = d["recommendation"]
    assert d["outcome"] == "counter" and r["type"] == "COUNTER"
    assert (r["amount"], r["term"], r["rate"], r["grade"]) == (3_000_000, 24, 19.0, "B")
    assert r["payment"] <= 156_923 and d["ml"]["trace"][0]["grade"] == "B"


def test_grade_oscillation_terminates_with_conservative_grade():
    """Грейд колеблется A ↔ D в зависимости от срока: фиксируем более консервативный и завершаем."""
    class FlipPD(FakePD):
        def predict(self, profile, *, product, amount, term, collateral, legal_form):
            self.calls.append((product, term))
            return PDResult((1.5 if term == 12 or term >= 36 else 9.0) / 100, "ml", "fake-3", [("receipts_cv", 0.4)], {})

    f = FlipPD({})
    d = run("C-B", f, amount=3_000_000, term=12)
    t = d["ml"]["trace"][0]
    assert len(f.calls) <= 12                                                    # не зациклились
    assert t["grade"] == "D" and t["zone"] == "grey"                             # у грейда D нет автолимита → серая зона
    assert d["outcome"] == "counter" and d["recommendation"]["product"] == "overdraft"   # каскад находит безопасный продукт
