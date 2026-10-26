"""HTTP API (FastAPI) и раздача статического UI. OpenAPI: /docs, /openapi.json."""
import secrets
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, db, mocks, pd_provider, scoring, service, smart
from . import policy as pol
from .config import policy
from .service import ServiceError


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    service.resume_pending()                    # продолжить заявки, прерванные перезапуском
    yield


app = FastAPI(title="Умный кредитный кабинет предпринимателя", version="0.1.0", lifespan=lifespan,
              description="Прототип цифрового кредитного конвейера для МСБ. Данные синтетические, внешние сервисы — моки.")


@app.exception_handler(ServiceError)
async def service_error(_: Request, e: ServiceError):
    return JSONResponse(status_code=e.status, content={"detail": e.message})


# ---------- авторизация ----------

def current_user(authorization: str | None = Header(default=None)) -> dict:
    token = (authorization or "").removeprefix("Bearer ").strip()
    with db.read() as c:
        r = c.execute("""SELECT u.login,u.role,u.client_id,u.name,s.expires FROM sessions s JOIN users u ON u.login=s.login
                         WHERE s.token=?""", (token,)).fetchone()
    if not r or datetime.fromisoformat(r["expires"]) < datetime.now(timezone.utc):
        raise HTTPException(401, "Требуется вход")
    return dict(r)


def client_only(u: dict = Depends(current_user)) -> dict:
    if u["role"] != "client":
        raise HTTPException(403, "Только для клиента")
    return u


def bank_only(u: dict = Depends(current_user)) -> dict:
    if u["role"] not in ("analyst", "admin"):
        raise HTTPException(403, "Только для сотрудника банка")
    return u


def admin_only(u: dict = Depends(current_user)) -> dict:
    if u["role"] != "admin":
        raise HTTPException(403, "Только для администратора стенда")
    return u


class LoginIn(BaseModel):
    login: str
    password: str


@app.get("/api/auth/demo-users", tags=["auth"], summary="Демо-учётки для входа (только для стенда)")
def demo_users():
    if not config.demo_mode():
        raise HTTPException(404, "Не найдено")
    with db.read() as c:
        rows = c.execute("SELECT login, role, name, hint FROM users ORDER BY rowid").fetchall()
    return {"password": db.DEMO_PASSWORD, "users": [dict(r) for r in rows]}


LOGIN_MAX_FAILS, LOGIN_WINDOW_S = 8, 300
_LOGIN_FAILS: dict[str, list[float]] = {}                  # логин → моменты неудачных попыток (в памяти процесса)
_login_lock = threading.Lock()


def _now() -> float:
    return time.monotonic()


def _throttled(login: str) -> bool:
    with _login_lock:
        recent = [t for t in _LOGIN_FAILS.get(login, []) if _now() - t < LOGIN_WINDOW_S]
        _LOGIN_FAILS[login] = recent
        return len(recent) >= LOGIN_MAX_FAILS


def _register_fail(login: str) -> None:
    with _login_lock:
        _LOGIN_FAILS.setdefault(login, []).append(_now())


@app.post("/api/auth/login", tags=["auth"])
def login(body: LoginIn):
    name = body.login.strip().lower()[:64]
    if _throttled(name):                                    # до PBKDF2: перебор не должен ещё и нагружать процессор
        raise HTTPException(429, "Слишком много неудачных попыток. Подождите несколько минут.")
    with db.tx() as c:
        u = c.execute("SELECT * FROM users WHERE login=?", (body.login.strip(),)).fetchone()
        if not u or not secrets.compare_digest(u["pw_hash"], db.hash_pw(body.password, u["salt"])):
            _register_fail(name)
            raise HTTPException(401, "Неверный логин или пароль")
        _LOGIN_FAILS.pop(name, None)
        token = secrets.token_urlsafe(32)
        c.execute("INSERT INTO sessions(token,login,expires) VALUES(?,?,?)",
                  (token, u["login"], (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat(timespec="seconds")))
    return {"token": token, "user": {"login": u["login"], "role": u["role"], "name": u["name"], "client_id": u["client_id"]}}


@app.get("/api/auth/me", tags=["auth"])
def me(u: dict = Depends(current_user)):
    return {"login": u["login"], "role": u["role"], "name": u["name"], "client_id": u["client_id"]}


@app.post("/api/auth/logout", tags=["auth"])
def logout(authorization: str | None = Header(default=None)):
    token = (authorization or "").removeprefix("Bearer ").strip()
    with db.tx() as c:
        c.execute("DELETE FROM sessions WHERE token=?", (token,))
    return {"ok": True}


# ---------- служебные ----------

@app.get("/api/health/live", tags=["ops"])
def live():
    return {"status": "ok"}


@app.get("/api/health/ready", tags=["ops"])
def ready():
    with db.read() as c:
        c.execute("SELECT 1 FROM users LIMIT 1").fetchone()
    return {"status": "ready", "policy_version": policy()["version"]}


@app.get("/api/products", tags=["catalog"], summary="Каталог продуктов и параметры политики")
def products(u: dict = Depends(current_user)):
    st = db.runtime_settings()
    out = []
    cl = mocks.get_client(u["client_id"]) if u["client_id"] else None
    for k, p in policy()["products"].items():
        item = {"id": k, **{x: p[x] for x in ("title", "tagline", "kind", "min_amount", "max_amount", "min_term", "max_term", "collateral", "fee")}}
        item["collateral_options"] = service.collateral_options(u["client_id"], p["collateral"])
        item["eligible"] = not (p.get("needs_msp_priority") and cl and not (cl["msp_registry"] and cl["priority_industry"]))
        out.append(item)
    return {"key_rate": st["key_rate"], "policy_version": policy()["version"], "products": out}


# ---------- клиент ----------

class Consents(BaseModel):
    pd: bool = False
    bureau: bool = False
    fns: bool = False


class ApplicationIn(BaseModel):
    product: str
    amount: int = Field(gt=0, le=1_000_000_000)
    term: int = Field(gt=0, le=600)
    purpose: str | None = Field(default=None, max_length=40)
    purpose_text: str | None = Field(default=None, max_length=500)
    collateral: str = Field(default="none", max_length=20)
    consents: Consents


class QuoteIn(BaseModel):
    product: str = Field(max_length=30)
    amount: int = Field(gt=0, le=1_000_000_000)
    term: int = Field(gt=0, le=600)
    collateral: str = "none"


class SignIn(BaseModel):
    code: str


class TopUpIn(BaseModel):
    amount: int = Field(ge=1000, le=5_000_000)


class DocsIn(BaseModel):
    note: str | None = Field(default=None, max_length=300)


@app.get("/api/client/profile", tags=["client"], summary="Что банк уже знает о бизнесе + предодобрение")
def profile(u: dict = Depends(client_only)):
    cl, enr, st = service.client_enrichment(u)
    p = scoring.build_profile(cl, enr)
    return {
        "company": {k: cl[k] for k in ("name", "legal_form", "inn", "ogrn", "okved", "director", "address", "registered", "tax_regime", "account")},
        "tenure_months": cl["tenure_months"], "receipts": cl["receipts"], "avg_receipts": round(p["avg"]), "dynamics": round(p["dynamics"], 3),
        "existing_payments": cl["existing_payments"], "key_rate": st["key_rate"],
        "msp": cl["msp_registry"] and cl["priority_industry"],
        "account": service.account_view(u["client_id"]),
        "loans": [x for x in (service.loan_summary(db.row_to_app(r)) for r in _disbursed_rows(u["client_id"])) if x],
        "preapproval": [{k: v for k, v in x.items() if k != "grade"} for x in pol.preapproval(cl, enr, st["key_rate"])],   # внутренний грейд клиенту не показываем
    }


@app.get("/api/client/forecast", tags=["client"], summary="Финансовый радар: прогноз свободного остатка на 90 дней, кассовый разрыв и предложение из лимита")
def client_forecast(scenario: float = 0.0, u: dict = Depends(client_only)):
    cl, enr, st = service.client_enrichment(u)
    p = scoring.build_profile(cl, enr)
    scheds = [s for s in (service._schedule(db.row_to_app(r)) for r in _disbursed_rows(u["client_id"])) if s]
    return smart.forecast(p, service.account_view(u["client_id"])["balance"], scheds, pol.preapproval(cl, enr, st["key_rate"]),
                          scenario=max(-0.9, min(float(scenario), 1.0)))


@app.get("/api/client/limit", tags=["client"], summary="Умный лимит: единый кредитный лимит клиента, использование и что его поднимет")
def client_limit(u: dict = Depends(client_only)):
    cl, enr, st = service.client_enrichment(u)
    p = scoring.build_profile(cl, enr)
    loans = [x for x in (service.loan_summary(db.row_to_app(r)) for r in _disbursed_rows(u["client_id"])) if x]
    return smart.limit(p, st["key_rate"], loans, pol.preapproval(cl, enr, st["key_rate"]))


def _disbursed_rows(client_id: str):
    with db.read() as c:
        return c.execute("SELECT * FROM applications WHERE client_id=? AND status='DISBURSED' ORDER BY seq DESC", (client_id,)).fetchall()


@app.get("/api/client/account", tags=["client"], summary="Расчётный счёт (демо): номер и баланс")
def account(u: dict = Depends(client_only)):
    return service.account_view(u["client_id"])


@app.post("/api/client/account/topup", tags=["client"], summary="Пополнить счёт (демо, реальных операций нет)")
def topup(body: TopUpIn, u: dict = Depends(client_only)):
    return service.account_topup(u, body.amount)


@app.post("/api/client/applications/{app_id}/pay", tags=["client"], summary="Оплатить ближайший платёж по графику (моделируется)")
def pay(app_id: str, u: dict = Depends(client_only)):
    return service.pay_next(u, app_id)


@app.post("/api/client/quote", tags=["client"], summary="Симулятор «что если»")
def quote(body: QuoteIn, u: dict = Depends(client_only)):
    service.validate_request(u, body.product, body.amount, body.term, body.collateral)
    cl, enr, st = service.client_enrichment(u)
    p = scoring.build_profile(cl, enr)
    grade = scoring.score(p)["grade"]
    grade = "C" if grade in ("D", "E") else grade           # индикативный расчёт; итог назовёт банк
    return pol.quote(body.product, grade, p, body.amount, body.term, body.collateral, st["key_rate"]) | {"indicative": True}


@app.get("/api/client/applications", tags=["client"])
def my_applications(u: dict = Depends(client_only)):
    with db.read() as c:
        return service.list_for_client(c, u)


@app.post("/api/client/applications", tags=["client"], status_code=201, summary="Создать и отправить заявку (Idempotency-Key)")
def create_app(body: ApplicationIn, u: dict = Depends(client_only), idempotency_key: str | None = Header(default=None)):
    app_id = service.create_application(u, body.model_dump(), idempotency_key)
    return {"id": app_id}


@app.get("/api/client/applications/{app_id}", tags=["client"])
def get_app(app_id: str, u: dict = Depends(client_only)):
    with db.read() as c:
        return service.client_view(c, service._own(c, u, app_id))


@app.post("/api/client/applications/{app_id}/accept", tags=["client"])
def accept(app_id: str, u: dict = Depends(client_only)):
    service.client_accept(u, app_id)
    return {"ok": True}


@app.post("/api/client/applications/{app_id}/decline-offer", tags=["client"])
def decline_offer(app_id: str, u: dict = Depends(client_only)):
    service.client_withdraw(u, app_id, "Клиент отказался от предложения")
    return {"ok": True}


@app.post("/api/client/applications/{app_id}/withdraw", tags=["client"])
def withdraw(app_id: str, u: dict = Depends(client_only)):
    service.client_withdraw(u, app_id)
    return {"ok": True}


@app.post("/api/client/applications/{app_id}/sign", tags=["client"])
def sign(app_id: str, body: SignIn, u: dict = Depends(client_only)):
    service.client_sign(u, app_id, body.code)
    return {"ok": True}


@app.post("/api/client/applications/{app_id}/documents", tags=["client"], summary="Подключить выписку / ответить на запрос документов")
def docs(app_id: str, body: DocsIn, u: dict = Depends(client_only)):
    service.client_docs(u, app_id, body.model_dump())
    return {"ok": True}


# ---------- банк ----------

class DecisionIn(BaseModel):
    action: str = Field(description="approve | request_docs | decline")
    amount: int | None = None
    term: int | None = None
    reasons: list[str] = Field(default=[], max_length=20)
    comment: str | None = Field(default=None, max_length=1000)


@app.get("/api/bank/applications", tags=["bank"])
def bank_apps(u: dict = Depends(bank_only)):
    with db.read() as c:
        return service.bank_list(c)


@app.get("/api/bank/stats", tags=["bank"])
def bank_stats(u: dict = Depends(bank_only)):
    with db.read() as c:
        return service.stats(c)


@app.get("/api/bank/applications/{app_id}", tags=["bank"])
def bank_app(app_id: str, u: dict = Depends(bank_only)):
    with db.read() as c:
        return service.bank_view(c, service.load(c, app_id))


@app.post("/api/bank/applications/{app_id}/decision", tags=["bank"], summary="Решение аналитика на ручном разборе")
def bank_decision(app_id: str, body: DecisionIn, u: dict = Depends(bank_only)):
    service.analyst_decide(u, app_id, body.model_dump())
    return {"ok": True}


# ---------- админ-пульт ----------

class SettingsIn(BaseModel):
    key_rate: float | None = Field(default=None, ge=1, le=40)
    bureau_mode: str | None = Field(default=None, pattern="^(ok|down)$")
    step_delay: float | None = Field(default=None, ge=0, le=10)
    decision_mode: str | None = Field(default=None, pattern="^(rules|ml_cascade)$")


@app.get("/api/admin/settings", tags=["admin"])
def get_settings(u: dict = Depends(admin_only)):
    return db.runtime_settings() | {"ml": pd_provider.get_provider().status()}


@app.post("/api/admin/settings", tags=["admin"])
def set_settings(body: SettingsIn, u: dict = Depends(admin_only)):
    with db.tx() as c:
        for k, v in body.model_dump(exclude_none=True).items():
            db.set_setting(c, k, v)
    return db.runtime_settings() | {"ml": pd_provider.get_provider().status()}


@app.post("/api/admin/reset", tags=["admin"], summary="Сбросить демо-данные")
def reset(u: dict = Depends(admin_only)):
    db.reset_data()
    return {"ok": True}


class RevalidatedStatic(StaticFiles):
    """Статика всегда перепроверяется по ETag: после обновления никто не видит старый интерфейс из кэша браузера."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/", RevalidatedStatic(directory=str(config.STATIC_DIR), html=True), name="static")
