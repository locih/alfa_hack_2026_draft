"""Сквозная проверка ML-конвейера: синтетика → обучение → артефакты → предикт → каскад на настоящей модели.

Требует LightGBM и системной OpenMP (в Docker-образе ml/Dockerfile есть). Иначе модуль пропускается.
Метрики здесь проверяют только то, что конвейер работает; качество на реальных данных этим не доказывается.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

try:
    import lightgbm  # noqa: F401
    import pandas as pd
    import sklearn  # noqa: F401
except Exception as e:                                           # нет пакета или libomp
    pytest.skip(f"ML-зависимости недоступны: {e}", allow_module_level=True)

from app import cascade, mocks, scoring
from app.pd_provider import PDProvider
from ml import features as F
from ml import synth
from ml.predict import ModelUnavailable, PDModel, pd_to_score

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def trained(tmp_path_factory):
    d = tmp_path_factory.mktemp("ml")
    data, out = d / "smoke.csv", d / "pd_smoke"
    synth.generate(8000, seed=3).to_csv(data, index=False)
    r = subprocess.run([sys.executable, "-m", "ml.train", "--data", str(data), "--out", str(out), "--version", "pd-smoke",
                        "--params", json.dumps({"n_estimators": 250, "learning_rate": 0.08, "min_child_samples": 40})],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    return {"dir": out, "data": data, "stdout": r.stdout}


def test_artifacts_and_metadata(trained):
    out = trained["dir"]
    for f in ("model.txt", "calibration.json", "meta.json", "metrics.json", "feature_importance.csv"):
        assert (out / f).exists(), f
    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    assert meta["model_version"] == "pd-smoke" and meta["schema_hash"] == F.schema_hash() and meta["features"] == F.FEATURES
    assert meta["target"] == "default_12m" and "90+" in meta["target_definition"] and len(meta["data_sha256"]) == 64
    m = json.loads((out / "metrics.json").read_text(encoding="utf-8"))
    assert m["test"]["auc"] > 0.62                                           # конвейер обучился: сигнал в синтетике есть
    assert abs(m["test"]["mean_pd"] - m["test"]["bad_rate"]) < 0.03          # калибровка: средняя PD ≈ доля дефолтов
    assert len(m["calibration_deciles_test"]) >= 5 and "zones_test" in m and m["psi_train_vs_test"] < 0.25


def test_predict_is_calibrated_probability_and_monotone(trained):
    model = PDModel.load(str(trained["dir"]))
    cl = mocks.get_client("C-B")
    enr, _ = mocks.collect(cl, False, "ok")
    p = scoring.build_profile(cl, enr)
    base = F.build(p, product="working", kind="annuity", amount=2_000_000, term=24, collateral="none", legal_form="ООО", ncf_margin=0.12)
    pd0 = model.predict_pd(base)
    assert 0 < pd0 < 1
    worse = dict(base, bureau_max_overdue_24m=59.0, bureau_current_overdue_days=25.0, tax_debt_log=12.0)
    assert model.predict_pd(worse) >= pd0                                    # монотонные ограничения: просрочка не снижает PD
    nan = dict(base, bureau_available=0.0, bureau_history_months=float("nan"), bureau_max_overdue_24m=float("nan"))
    assert 0 < model.predict_pd(nan) < 1                                     # пропуски БКИ не ломают инференс
    top = model.explain(worse, top=3)
    assert len(top) == 3 and all(n in F.FEATURES for n, _ in top)
    assert 0 <= pd_to_score(pd0) <= 100


def test_batch_cli_scores_csv(trained, tmp_path):
    out = tmp_path / "scored.csv"
    sample = pd.read_csv(trained["data"]).head(50)
    (tmp_path / "in.csv").write_text(sample.to_csv(index=False), encoding="utf-8")
    r = subprocess.run([sys.executable, "-m", "ml.predict", "--model", str(trained["dir"]), "--data", str(tmp_path / "in.csv"), "--out", str(out)],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    scored = pd.read_csv(out)
    assert len(scored) == 50 and scored["pd"].between(0, 1).all() and scored["score"].between(0, 100).all()


def test_model_with_foreign_feature_schema_is_refused(trained, tmp_path):
    import shutil
    bad = tmp_path / "bad"
    shutil.copytree(trained["dir"], bad)
    meta = json.loads((bad / "meta.json").read_text(encoding="utf-8"))
    meta["schema_hash"] = "deadbeef0000"
    (bad / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    with pytest.raises(ModelUnavailable):
        PDModel.load(str(bad))


def test_app_degrades_to_scorecard_when_model_dir_is_broken(tmp_path, monkeypatch):
    (tmp_path / "meta.json").write_text("{not json", encoding="utf-8")
    monkeypatch.setenv("MODEL_DIR", str(tmp_path))
    from ml.predict import load_default
    assert load_default() is None
    assert PDProvider(None).status()["source"] == "scorecard"


def test_cascade_runs_on_the_trained_model(trained):
    prov = PDProvider(PDModel.load(str(trained["dir"])))
    assert prov.status()["source"] == "ml" and prov.status()["version"] == "pd-smoke"
    seen = set()
    for cid, product, amount, term, col in [("C-A", "working", 3_000_000, 24, "none"), ("C-B", "working", 3_000_000, 12, "none"),
                                            ("C-A", "development", 6_000_000, 48, "equipment"), ("C-C", "overdraft", 400_000, 12, "none")]:
        cl = mocks.get_client(cid)
        enr, _ = mocks.collect(cl, True, "ok")
        d = cascade.evaluate_cascade(dict(product=product, amount=amount, term=term, collateral=col), cl, enr, 14.0, provider=prov)
        assert d["outcome"] in ("approve", "counter", "manual", "decline") and d["ml"]["source"] == "ml"
        assert d["ml"]["trace"]
        if d.get("stage") == "eligibility":                      # ИП Громов: овердрафт недоступен по стажу в банке — PD не считается
            assert d["outcome"] == "decline" and "pd" not in d
            continue
        assert 0 < d["pd"] < 100 and d["ml"]["contributions"]
        seen.add(d["outcome"])
    assert seen


def test_meta_without_version_means_model_unavailable_not_a_crash(trained, tmp_path, monkeypatch):
    import shutil
    bad = tmp_path / "pd_current"
    shutil.copytree(trained["dir"], bad)
    meta = json.loads((bad / "meta.json").read_text(encoding="utf-8"))
    meta.pop("model_version")
    (bad / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    with pytest.raises(ModelUnavailable):
        PDModel.load(str(bad))                                                  # раньше: KeyError мимо try
    monkeypatch.setenv("MODEL_DIR", str(bad))
    from ml.predict import load_default
    assert load_default() is None
