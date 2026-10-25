"""SQLite: WAL, внешние ключи, транзакции BEGIN IMMEDIATE. В проде — PostgreSQL (схема совместима)."""
import hashlib
import json
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  login TEXT PRIMARY KEY, pw_hash TEXT NOT NULL, salt TEXT NOT NULL,
  role TEXT NOT NULL, client_id TEXT, name TEXT NOT NULL, hint TEXT);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, login TEXT NOT NULL REFERENCES users(login), expires TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, client_id TEXT NOT NULL, product TEXT NOT NULL,
  amount INTEGER NOT NULL, term INTEGER NOT NULL, purpose TEXT, purpose_text TEXT, collateral TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL, updated TEXT NOT NULL,
  consents TEXT, enrichment TEXT, decision TEXT, offer TEXT, contract TEXT,
  doc_request TEXT, statement_uploaded INTEGER NOT NULL DEFAULT 0, sign_code TEXT, final_reason TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL REFERENCES applications(id),
  ts TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, vis TEXT NOT NULL DEFAULT 'both',
  from_status TEXT, to_status TEXT, message TEXT NOT NULL, data TEXT);
CREATE INDEX IF NOT EXISTS ix_events_app ON events(app_id, id);
CREATE TABLE IF NOT EXISTS accounts (client_id TEXT PRIMARY KEY, balance INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency (key TEXT NOT NULL, login TEXT NOT NULL, app_id TEXT NOT NULL, PRIMARY KEY (key, login));
"""

JSON_COLS = ("consents", "enrichment", "decision", "offer", "contract", "doc_request")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    path = config.db_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    c = sqlite3.connect(path, timeout=15, isolation_level=None)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("PRAGMA busy_timeout=15000")
    return c


@contextmanager
def tx():
    c = connect()
    try:
        c.execute("BEGIN IMMEDIATE")
        yield c
        c.execute("COMMIT")
    except BaseException:
        c.execute("ROLLBACK")
        raise
    finally:
        c.close()


@contextmanager
def read():
    c = connect()
    try:
        yield c
    finally:
        c.close()


def hash_pw(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()


def row_to_app(row) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    for k in JSON_COLS:
        d[k] = json.loads(d[k]) if d.get(k) else None
    return d


def dumps(v) -> str:
    return json.dumps(v, ensure_ascii=False)


def get_setting(c, name: str, default=None):
    r = c.execute("SELECT value FROM settings WHERE name=?", (name,)).fetchone()
    return json.loads(r["value"]) if r else default


def set_setting(c, name: str, value) -> None:
    c.execute("INSERT INTO settings(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
              (name, dumps(value)))


def runtime_settings() -> dict:
    with read() as c:
        return {
            "key_rate": get_setting(c, "key_rate", config.env_key_rate()),
            "bureau_mode": get_setting(c, "bureau_mode", "ok"),
            "step_delay": get_setting(c, "step_delay", config.env_step_delay()),
            "decision_mode": get_setting(c, "decision_mode", config.env_decision_mode()),
        }


DEMO_PASSWORD = "demo123"

DEMO_USERS = [
    ("sever", "client", "C-A", "ООО «Север-Тех»", "Сильный клиент: одобрение, предодобрение, льготная программа"),
    ("lesnoy", "client", "C-B", "ООО «Лесной хлеб»", "Средний клиент: встречное предложение (дольше срок)"),
    ("gromov", "client", "C-C", "ИП Громов А. С.", "Сбой БКИ → ручной разбор → запрос выписки"),
    ("stroy", "client", "C-D", "ООО «СтройРесурс»", "Налоговая недоимка → отказ с понятной причиной"),
    ("analyst", "analyst", None, "Анна Кравцова, кредитный аналитик", "Рабочее место банка: очередь и ручной разбор"),
    ("admin", "admin", None, "Администратор стенда", "Как аналитик + пульт: сброс, режим БКИ, ключевая ставка"),
]


def reset_data() -> None:
    """Сброс демо-данных без потери учётных записей и сессий."""
    with tx() as c:
        for t in ("idempotency", "events", "applications", "accounts", "settings"):
            c.execute(f"DELETE FROM {t}")
        set_setting(c, "key_rate", config.env_key_rate())
        set_setting(c, "bureau_mode", "ok")
        set_setting(c, "step_delay", config.env_step_delay())
        set_setting(c, "decision_mode", config.env_decision_mode())


def init_db(reset: bool = False) -> None:
    with tx() as c:
        if reset:
            for t in ("idempotency", "events", "applications", "accounts", "sessions", "users", "settings"):
                c.execute(f"DROP TABLE IF EXISTS {t}")
        for stmt in SCHEMA.strip().split(";"):
            if stmt.strip():
                c.execute(stmt)
        if not c.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            for login, role, cid, name, hint in DEMO_USERS:
                salt = secrets.token_hex(8)
                c.execute("INSERT INTO users(login,pw_hash,salt,role,client_id,name,hint) VALUES(?,?,?,?,?,?,?)",
                          (login, hash_pw(DEMO_PASSWORD, salt), salt, role, cid, name, hint))
        if get_setting(c, "key_rate") is None:
            set_setting(c, "key_rate", config.env_key_rate())
            set_setting(c, "bureau_mode", "ok")
            set_setting(c, "step_delay", config.env_step_delay())
