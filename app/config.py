"""Конфигурация: статическая политика из YAML + переменные окружения."""
import os
from functools import lru_cache
from pathlib import Path

import yaml

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", BASE_DIR / "config"))
STATIC_DIR = Path(os.environ.get("STATIC_DIR", BASE_DIR / "static"))


def db_path() -> str:
    return os.environ.get("DB_PATH", str(BASE_DIR / "data" / "app.db"))


@lru_cache(maxsize=1)
def policy() -> dict:
    with open(CONFIG_DIR / "products.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


def env_key_rate() -> float:
    return float(os.environ.get("KEY_RATE", policy()["key_rate_default"]))


def env_decision_mode() -> str:
    return os.environ.get("DECISION_MODE", policy()["ml"]["decision_mode"])


def demo_mode() -> bool:
    """DEMO_MODE=0 скрывает публичный список демо-учёток (для не-демо развёртываний). По умолчанию включён — для проверки жюри."""
    return os.environ.get("DEMO_MODE", "1") != "0"


def env_step_delay() -> float:
    return float(os.environ.get("STEP_DELAY_SEC", "1.2"))
