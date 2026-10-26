"""Модель-заглушка: PD по идентификатору клиента равен PD скоркарты, поэтому решения каскада не меняются."""
import pytest

from app import cascade, mocks, pd_provider, scoring
from app.pd_provider import PDProvider
from ml import stub
from ml.predict import load_default


@pytest.fixture()
def model_dir(tmp_path, monkeypatch):
    out = tmp_path / "pd_current"
    monkeypatch.setattr("sys.argv", ["ml.stub", "--out", str(out)])
    stub.main()
    monkeypatch.setenv("MODEL_DIR", str(out))
    return out


def test_stub_returns_scorecard_pd_for_every_client_and_data_variant(model_dir):
    model = stub.LookupPDModel.load(str(model_dir))
    for cid in mocks.CLIENTS:
        cl = mocks.get_client(cid)
        for docs in (False, True):
            for bureau in ("ok", "down"):
                p = scoring.build_profile(cl, mocks.collect(cl, docs, bureau)[0])
                feats = {"client_id": cid, "data_variant": stub.variant(p)}
                assert model.predict_pd(feats) == scoring.pd_fraction(scoring.score(p)["total"])
    assert model.explain({}) == []


def test_default_loader_picks_up_the_stub_without_lightgbm(model_dir):
    m = load_default()
    assert isinstance(m, stub.LookupPDModel) and m.version.startswith("stub-lookup-scorecard-")


def test_cascade_decisions_are_the_same_with_stub_and_with_scorecard_fallback(model_dir):
    cases = [("C-A", "working", 3_000_000, 24), ("C-B", "working", 3_000_000, 12), ("C-B", "development", 5_000_000, 36),
             ("C-C", "overdraft", 1_000_000, 12), ("C-D", "working", 1_000_000, 24)]
    checked = 0
    for cid, product, amount, term in cases:
        cl = mocks.get_client(cid)
        enr, _ = mocks.collect(cl, True, "ok")
        app = dict(product=product, amount=amount, term=term, collateral="none")
        a = cascade.evaluate_cascade(app, cl, enr, 14.0, provider=PDProvider(load_default()))
        b = cascade.evaluate_cascade(app, cl, enr, 14.0, provider=PDProvider(None))
        for k in ("outcome", "pd", "grade", "recommendation", "reasons"):
            assert a.get(k) == b.get(k), (cid, product, k)
        if "ml" in a:                                      # отказ по стоп-правилу случается до модели
            assert a["ml"]["source"] == "ml" and b["ml"]["source"] == "scorecard"
            assert [(t["product"], t["pd"], t["zone"]) for t in a["ml"]["trace"]] == [(t["product"], t["pd"], t["zone"]) for t in b["ml"]["trace"]]
            checked += 1
    assert checked >= 4
    pd_provider.reset_provider()
