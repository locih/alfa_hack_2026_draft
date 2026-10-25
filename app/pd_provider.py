"""Источник PD для каскада: обученная ML-модель, а если её нет или она не загрузилась — скоркарта (запасной режим).

Приложение работает и без ML-зависимостей (lightgbm/numpy): модель подгружается только при наличии артефактов
в MODEL_DIR (по умолчанию models/pd_current) и совпадении набора признаков с кодом.
"""
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import lru_cache

from ml import features as F
from ml.predict import load_default

from . import scoring
from .config import policy


@dataclass
class PDResult:
    pd: float                                    # доля, 0..1
    source: str                                  # "ml" | "scorecard"
    version: str
    contributions: list[tuple[str, float]] | None = None
    features: dict = field(default_factory=dict)
    lazy_contributions: Callable[[], list[tuple[str, float]]] | None = None   # SHAP считается только когда вклады реально нужны

    def get_contributions(self) -> list[tuple[str, float]] | None:
        if self.contributions is None and self.lazy_contributions:
            self.contributions = self.lazy_contributions()
        return self.contributions


class PDProvider:
    def __init__(self, model=None):
        self.model = model

    def status(self) -> dict:
        if self.model:
            m = self.model.meta
            return {"source": "ml", "version": self.model.version, "calibration": m.get("calibration_method"),
                    "metrics": m.get("summary"), "trained": m.get("created_at")}
        return {"source": "scorecard", "version": "scorecard-" + policy()["version"],
                "note": "обученная модель не найдена — PD считается по скоркарте (шкала PDO)"}

    def predict(self, profile: dict, *, product: str, amount: float, term: int, collateral: str, legal_form: str) -> PDResult:
        pc = policy()
        feats = F.build(profile, product=product, kind=pc["products"][product]["kind"], amount=amount, term=term,
                        collateral=collateral, legal_form=legal_form, ncf_margin=pc["industry_margin"][profile["industry"]])
        if self.model:
            return PDResult(self.model.predict_pd(feats), "ml", self.model.version, None, feats,
                            lazy_contributions=lambda: self.model.explain(feats, top=8))
        return PDResult(scoring.pd_fraction(scoring.score(profile)["total"]), "scorecard", "scorecard-" + pc["version"], None, feats)


@lru_cache(maxsize=1)
def get_provider() -> PDProvider:
    return PDProvider(load_default())


def reset_provider() -> None:
    get_provider.cache_clear()
