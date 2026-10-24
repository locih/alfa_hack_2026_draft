import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["STEP_DELAY_SEC"] = "0"          # конвейер выполняется синхронно
os.environ["DB_PATH"] = str(Path(tempfile.mkdtemp()) / "test.db")
os.environ["KEY_RATE"] = "14.0"

from fastapi.testclient import TestClient  # noqa: E402

from app import db  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def api():
    with TestClient(app) as c:
        db.reset_data()
        yield c


def login(api, name):
    r = api.post("/api/auth/login", json={"login": name, "password": "demo123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


CONSENTS = {"pd": True, "bureau": True, "fns": True}


def submit(api, h, product="working", amount=3_000_000, term=24, collateral="none", **kw):
    r = api.post("/api/client/applications", headers=h, json={
        "product": product, "amount": amount, "term": term, "collateral": collateral, "consents": CONSENTS, **kw})
    assert r.status_code == 201, r.text
    return r.json()["id"]
