"""Модель-заглушка: PD по идентификатору клиента из готовой таблицы значений скоркарты.

Реализует тот же интерфейс, что ml.predict.PDModel (version, meta, predict_pd, explain), поэтому приложение
подключает её как обычную модель. Обучения нет: таблицу строит скрипт из скоркарты.

    python -m ml.stub --out models/pd_current
"""
import argparse
import json
from pathlib import Path

KIND = "lookup"


def variant(profile: dict) -> str:
    """Ключ состояния данных клиента: скоркарта меняется при сбое БКИ и подключении выписки другого банка."""
    return f"bureau={int(bool(profile['bureau_ok']))};statement={profile['statement_source']}"


class LookupPDModel:
    def __init__(self, table: dict, meta: dict, path: str):
        self.table, self.meta, self.path = table, meta, path
        self.version = meta["model_version"]

    @classmethod
    def load(cls, path: str) -> "LookupPDModel":
        p = Path(path)
        meta = json.loads((p / "meta.json").read_text(encoding="utf-8"))
        table = json.loads((p / "lookup.json").read_text(encoding="utf-8"))
        return cls(table, meta, str(p))

    def predict_pd(self, features: dict) -> float:
        return self.table[features["client_id"]][features["data_variant"]]

    def explain(self, features: dict, top: int = 5) -> list[tuple[str, float]]:
        return []                                     # у таблицы нет вкладов признаков


def build_table() -> dict:
    from app import mocks, scoring
    table: dict = {}
    for cid in sorted(mocks.CLIENTS):
        cl = mocks.get_client(cid)
        for docs in (False, True):
            for bureau in ("ok", "down"):
                enr, _ = mocks.collect(cl, docs, bureau)
                p = scoring.build_profile(cl, enr)
                table.setdefault(cid, {})[variant(p)] = scoring.pd_fraction(scoring.score(p)["total"])
    return table


def main() -> None:
    from app.config import policy
    ap = argparse.ArgumentParser(description="Строит модель-заглушку (PD скоркарты по client_id)")
    ap.add_argument("--out", required=True)
    out = Path(ap.parse_args().out)
    out.mkdir(parents=True, exist_ok=True)
    table = build_table()
    (out / "lookup.json").write_text(json.dumps(table, ensure_ascii=False, indent=1), encoding="utf-8")
    meta = {"kind": KIND, "model_version": "stub-lookup-scorecard-" + policy()["version"],
            "note": "заглушка: PD скоркарты по идентификатору клиента, не обученная модель"}
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Заглушка → {out}: клиентов {len(table)}, версия {meta['model_version']}")


if __name__ == "__main__":
    main()
