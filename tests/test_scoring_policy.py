"""Unit-тесты скоринга, цены и политики: «golden»-значения совпадают с docs/credit-policy.md."""
import pytest

from app import mocks, policy, pricing, scoring
from app.config import policy as cfg
from app.states import TERMINAL, TRANSITIONS


def run(cid, product="working", amount=3_000_000, term=24, collateral="none", stmt=False, key=14.0, bureau="ok"):
    cl = mocks.get_client(cid)
    enr, _ = mocks.collect(cl, stmt, bureau)
    app = dict(product=product, amount=amount, term=term, collateral=collateral)
    return policy.evaluate(app, cl, enr, key)


def test_scorecard_maximum_is_100_and_blocks_sum():
    cl = mocks.get_client("C-A")
    enr, _ = mocks.collect(cl, False, "ok")
    sc = scoring.score(scoring.build_profile(cl, enr))
    assert sum(f["max"] for f in sc["factors"]) == 100
    assert len(sc["factors"]) == 14


@pytest.mark.parametrize("cid,stmt,total,grade", [("C-A", False, 95, "A"), ("C-B", False, 74, "B"), ("C-C", True, 62, "C")])
def test_golden_scores(cid, stmt, total, grade):
    d = run(cid, stmt=stmt)
    assert (d["score"], d["grade"]) == (total, grade)


def test_p_max_matches_report_examples():
    assert run("C-A")["afford"]["p_max"] == 422_000
    assert round(run("C-B")["afford"]["p_max"]) == 156_923
    assert round(run("C-C", stmt=True)["afford"]["p_max"]) == 51_429


@pytest.mark.parametrize("grade,rate", [("A", 17.5), ("B", 18.5), ("C", 20.5)])
def test_price_table_working_loan_up_to_12_months(grade, rate):
    assert pricing.rate_for("working", grade, 12, "none", False, 14.0) == rate


def test_price_cap_and_key_rate_parametrisation():
    assert pricing.rate_for("working", "D", 36, "none", True, 14.0) == 24.0           # потолок K + 10
    assert pricing.rate_for("working", "A", 12, "none", False, 16.0) == 19.5          # цена растёт с K
    assert pricing.rate_for("preferential", "A", 12, "none", False, 14.0) == 17.0     # K + 3
    assert pricing.rate_for("development", "C", 24, "equipment", False, 14.0) < pricing.rate_for("development", "C", 24, "none", False, 14.0)


def test_collateral_lowers_rate_visibly_and_monotonically():
    r = {c: pricing.rate_for("working", g, 24, c, False, 14.0) for g in "ABC" for c in ("none", "guarantor", "equipment", "realty")}
    for g in "ABC":
        none, gu, eq, re_ = (pricing.rate_for("working", g, 24, c, False, 14.0) for c in ("none", "guarantor", "equipment", "realty"))
        assert none > gu >= eq >= re_ and none - re_ >= 2.0, (g, none, gu, eq, re_)      # без обеспечения ставка выше
        assert none - re_ <= 4.0                                                          # но не «минус 5–8 пунктов»


def test_annuity_schedule_closes_to_zero_and_sums():
    rows = pricing.schedule(1_000_000, 18.5, 12)
    assert rows[-1]["balance"] == 0 and sum(r["principal"] for r in rows) == 1_000_000
    assert pricing.annuity(1_000_000, 18.5, 12) == 91_918


def test_counter_offer_never_exceeds_request_and_fits_p_max():
    for amount in (1_500_000, 3_000_000, 4_000_000, 5_000_000):
        d = run("C-B", amount=amount, term=12)
        rec = d.get("recommendation")
        if rec:
            assert rec["amount"] <= amount
            assert rec["payment"] <= d["afford"]["p_max"] + 1


def test_counter_prefers_longer_term_then_smaller_amount():
    assert run("C-B", amount=3_000_000, term=12)["recommendation"]["term"] == 24          # тот же размер, больший срок
    big = run("C-B", amount=5_000_000, term=12)                                           # срок не спасает → меньшая сумма
    assert big["recommendation"]["term"] == 36 and big["recommendation"]["amount"] < 5_000_000


def test_stop_rule_has_priority_over_score():
    d = run("C-D", amount=2_000_000)
    assert d["outcome"] == "decline" and d["stops"][0]["id"] == "H06" and "score" not in d


def test_manual_route_conditions():
    assert run("C-C")["outcome"] == "manual"                                              # БКИ недоступно
    assert run("C-A", amount=5_000_000, term=36)["outcome"] in ("approve", "counter")     # A: авто до 5 млн
    assert run("C-B", amount=1_000_000, term=12)["outcome"] == "approve"
    d = run("C-A", product="development", amount=15_000_000, term=60, collateral="equipment")
    assert d["outcome"] == "manual" and any("лимита" in m for m in d["manual_reasons"])   # свыше автолимита


def test_eligibility_blocks_products():
    assert run("C-C", product="preferential", amount=600_000, term=12, stmt=True)["outcome"] == "decline"   # не приоритетная отрасль
    assert run("C-C", product="development", amount=1_000_000, term=24, collateral="equipment", stmt=True)["outcome"] == "decline"  # <12 мес.


def test_reasons_do_not_leak_thresholds():
    texts = " ".join(r["text"] + r["action"] for r in run("C-D", amount=2_000_000)["reasons"])
    assert "50 000" not in texts and "30 дн" not in texts


def test_state_machine_is_closed():
    for s, nxt in TRANSITIONS.items():
        assert nxt <= set(TRANSITIONS)
    assert TERMINAL == {"DISBURSED", "DECLINED", "WITHDRAWN", "EXPIRED"}
    assert len(TRANSITIONS) == 12
    assert sum(len(v) for v in TRANSITIONS.values()) == 22


def test_policy_catalog_has_four_products_two_mechanics():
    prods = cfg()["products"]
    assert set(prods) == {"working", "overdraft", "development", "preferential"}
    assert {p["kind"] for p in prods.values()} == {"annuity", "limit"}
