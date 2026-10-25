"""Шкала PDO — единственное место, где баллы переводятся в PD и обратно (скоркарта и ML-слой).

60 баллов = PD 5 %; каждые +15 баллов удваивают шансы «не дефолт к дефолту».
"""
import math

BASE_SCORE = 60
STEP = 15
BASE_ODDS = 19            # шансы «хорошо/плохо» при PD 5 %


def score_to_pd(score: float) -> float:
    """PD (доля 0..1) по баллам."""
    return 1 / (1 + BASE_ODDS * 2 ** ((score - BASE_SCORE) / STEP))


def pd_to_score(pd: float) -> float:
    """Баллы 0..100 по PD (доля 0..1)."""
    pd = min(max(pd, 1e-6), 1 - 1e-6)
    return max(0.0, min(100.0, BASE_SCORE + STEP * math.log2(((1 - pd) / pd) / BASE_ODDS)))
