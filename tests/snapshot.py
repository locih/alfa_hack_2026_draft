"""Снимок решений системы по четырём демо-клиентам: python tests/snapshot.py out.json [rules|ml_cascade].
Нужен, чтобы сравнить поведение до и после подключения PD-модели."""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.update(STEP_DELAY_SEC="0", KEY_RATE="14.0", DB_PATH=str(Path(tempfile.mkdtemp()) / "snap.db"))
if len(sys.argv) > 2:
    os.environ["DECISION_MODE"] = sys.argv[2]

from fastapi.testclient import TestClient  # noqa: E402

from app import db  # noqa: E402
from app.main import app  # noqa: E402

CASES = [(u, p, a, t, c) for u in ("sever", "lesnoy", "gromov", "stroy")
         for p, a, t, c in (("working", 3_000_000, 24, "none"), ("working", 3_000_000, 12, "none"),
                            ("working", 400_000, 12, "none"), ("development", 5_000_000, 36, "equipment"),
                            ("overdraft", 1_000_000, 12, "none"), ("working", 1_000_000, 24, "realty"))]
VOLATILE = {"id", "created_at", "updated_at", "at", "ts", "sign_code", "number", "date", "expires_at", "issued_at", "token", "created", "updated", "fetched_at", "valid_until"}


def clean(x):
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items() if k not in VOLATILE}
    if isinstance(x, list):
        return [clean(v) for v in x]
    return x


def main():
    out = {}
    with TestClient(app) as api:
        def hdr(n):
            return {"Authorization": "Bearer " + api.post("/api/auth/login", json={"login": n, "password": "demo123"}).json()["token"]}
        hb = hdr("analyst")
        for u, p, a, t, c in CASES:
            db.reset_data()
            h = hdr(u)
            r = api.post("/api/client/applications", headers=h, json={
                "product": p, "amount": a, "term": t, "collateral": c, "consents": {"pd": True, "bureau": True, "fns": True}})
            key = f"{u}|{p}|{a}|{t}|{c}"
            if r.status_code != 201:
                out[key] = {"http": r.status_code, "body": clean(r.json())}
                continue
            i = r.json()["id"]
            out[key] = {"client": clean(api.get(f"/api/client/applications/{i}", headers=h).json()),
                        "bank": clean(api.get(f"/api/bank/applications/{i}", headers=hb).json())}
    Path(sys.argv[1]).write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True))
    print(len(out), "cases")


main()
