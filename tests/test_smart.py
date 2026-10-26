"""«Умный» слой: прогноз кассового разрыва и единый лимит считаются теми же функциями, что скоринг и политика."""
from conftest import login


def test_forecast_shape_and_consistency(api):
    h = login(api, "sever")
    f = api.get("/api/client/forecast", headers=h).json()
    assert f["horizon_days"] == 90 and len(f["path"]) == 90 and len(f["months"]) == 3 and len(f["fact"]) == 12
    assert f["cushion"] >= 0 and all(m["receipts"] > 0 and 0.5 <= m["season"] <= 1.6 for m in f["months"])
    assert f["path"][0]["balance"] >= f["balance"] - f["cushion"] * 2     # первый день не падает без причины
    assert "модель" in f["assumptions"]["model"] or f["assumptions"]["model"]


def test_forecast_stress_scenario_finds_gap_and_offers_product(api):
    h = login(api, "lesnoy")
    base = api.get("/api/client/forecast", headers=h).json()
    stress = api.get("/api/client/forecast", params={"scenario": -0.9}, headers=h).json()
    assert stress["months"][0]["receipts"] < base["months"][0]["receipts"]
    assert stress["path"][-1]["balance"] <= base["path"][-1]["balance"]
    if stress["gap"]:
        assert stress["gap"]["amount"] % 50_000 == 0 and stress["gap"]["day"] >= 1
        if stress["offer"]:
            assert stress["offer"]["product"] in ("overdraft", "working", "development") and stress["offer"]["amount"] >= 50_000


def test_forecast_scenario_is_clamped(api):
    h = login(api, "sever")
    assert api.get("/api/client/forecast", params={"scenario": -5}, headers=h).json()["scenario"] == -0.9


def test_limit_matches_preapproval_and_lists_growth(api):
    h = login(api, "sever")
    lim = api.get("/api/client/limit", headers=h).json()
    pre = api.get("/api/client/profile", headers=h).json()["preapproval"]
    assert lim["limit"] == max(p["max_amount"] for p in pre if p.get("available"))
    assert lim["available"] == max(0, lim["limit"] - lim["used"]) and lim["p_max"] > 0
    assert all(g["effect"] >= 0 and g["title"] for g in lim["growth"])
    assert "grade" not in lim                                         # внутренний грейд клиенту не отдаём


def test_limit_for_blocked_client_is_zero(api):
    h = login(api, "stroy")
    lim = api.get("/api/client/limit", headers=h).json()
    assert lim["limit"] == 0 and lim["available"] == 0


def test_forecast_factors_and_band(api):
    h = login(api, "gromov")                                     # сбой БКИ и ИП с наличной выручкой — факторы должны это показать
    f = api.get("/api/client/forecast", headers=h).json()
    ids = [x["id"] for x in f["factors"]]
    assert ids == ["market", "activity", "finance", "reputation"] and 0.08 <= f["band"] <= 0.6
    assert f["cushion_multiplier"] >= 1.0 and all(m["low"] <= m["receipts"] <= m["high"] for m in f["months"])
    assert any("БКИ" in x["value"] for x in f["factors"] if x["id"] == "reputation")
