"""Оркестрация заявки: конвейер (проверка → решение → выдача), действия клиента и аналитика, представления."""
import logging
import secrets
import threading
import time
from datetime import date, datetime, timedelta, timezone

from . import db, mocks, pricing, scoring
from . import policy as pol
from .config import policy
from .reasons import REASONS, reason
from .states import CLIENT_HINTS, CLIENT_VIEW, STEPS, TERMINAL, TRANSIENT, TRANSITIONS


logger = logging.getLogger("credit-cabinet")


class ServiceError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


# ---------- базовые операции ----------

def load(c, app_id: str) -> dict:
    app = db.row_to_app(c.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone())
    if not app:
        raise ServiceError(404, "Заявка не найдена")
    return normalize(app)


def normalize(app: dict) -> dict:
    """Договоры, выданные до появления платежей, не имеют payments/repaid/schedule_start — достраиваем значения по умолчанию."""
    ct = app.get("contract")
    if ct:
        ct.setdefault("payments", [])
        ct.setdefault("repaid", False)
        ct.setdefault("schedule_start", ct.get("date"))
    return app


def log(c, app_id, actor, kind, message, vis="both", frm=None, to=None, data=None):
    c.execute("INSERT INTO events(app_id,ts,actor,kind,vis,from_status,to_status,message,data) VALUES(?,?,?,?,?,?,?,?,?)",
              (app_id, db.now(), actor, kind, vis, frm, to, message, db.dumps(data) if data is not None else None))


def move(c, app: dict, to: str, actor: str, message: str, vis: str = "both", bank_message: str | None = None, **fields):
    """Переход по таблице разрешённых; оптимистичная блокировка по version; событие пишется в той же транзакции."""
    frm = app["status"]
    if to not in TRANSITIONS[frm]:
        raise ServiceError(409, f"Переход {frm} → {to} запрещён")
    sets, vals = ["status=?", "version=version+1", "updated=?"], [to, db.now()]
    for k, v in fields.items():
        sets.append(f"{k}=?")
        vals.append(db.dumps(v) if k in db.JSON_COLS else v)
    cur = c.execute(f"UPDATE applications SET {','.join(sets)} WHERE id=? AND version=?", vals + [app["id"], app["version"]])
    if cur.rowcount != 1:
        raise ServiceError(409, "Заявка изменилась, обновите страницу")
    log(c, app["id"], actor, "status", message, vis, frm, to)
    if bank_message and vis == "client":
        log(c, app["id"], actor, "status", bank_message, "bank", frm, to)
    app["status"], app["version"] = to, app["version"] + 1
    for k, v in fields.items():
        app[k] = v


def _delay() -> float:
    return float(db.runtime_settings()["step_delay"])


def kick(app_id: str) -> None:
    if _delay() <= 0:
        run_pipeline(app_id)
    else:
        threading.Thread(target=run_pipeline, args=(app_id,), daemon=True).start()


def run_pipeline(app_id: str) -> None:
    for _ in range(12):
        with db.read() as c:
            r = c.execute("SELECT status FROM applications WHERE id=?", (app_id,)).fetchone()
        if not r:
            return
        step = {"VERIFICATION": step_verify, "DECISIONING": step_decide, "DISBURSING": step_disburse}.get(r["status"])
        if not step:
            return
        try:
            step(app_id)
        except ServiceError:
            return
        except Exception as e:                                      # сбой шага не должен оставлять заявку «зависшей» без следа
            logger.exception("Сбой шага %s заявки %s", step.__name__, app_id)
            _degrade(app_id, step.__name__, e)
            return


def _degrade(app_id: str, step_name: str, exc: Exception) -> None:
    """Деградация вместо зависания: запись в журнал банка и передача аналитику (где переход допустим)."""
    msg = f"Сбой автоматической обработки ({step_name}): {type(exc).__name__}: {exc}"[:300]
    try:
        with db.tx() as c:
            app = load(c, app_id)
            log(c, app_id, "system", "error", msg, "bank")
            if app["status"] in ("VERIFICATION", "DECISIONING"):
                dec = dict(app["decision"] or {}, outcome="manual", manual_reasons=[msg], reasons=[reason("R18")])
                move(c, app, "MANUAL_REVIEW", "system", "Заявку рассматривает специалист банка", "client", decision=dec)
    except ServiceError:
        pass


def resume_pending() -> int:
    """После перезапуска (в т.ч. «засыпания» бесплатного хостинга) продолжаем заявки, которые остановились между автоэтапами."""
    with db.read() as c:
        ids = [r["id"] for r in c.execute("SELECT id FROM applications WHERE status IN ('VERIFICATION','DECISIONING','DISBURSING')")]
    for app_id in ids:
        kick(app_id)
    return len(ids)


def _sleep(delay: float) -> None:
    if delay > 0:
        time.sleep(delay)


# ---------- шаги конвейера ----------

def step_verify(app_id: str) -> None:
    st = db.runtime_settings()
    _sleep(st["step_delay"])
    with db.read() as c:
        app = load(c, app_id)
    if app["status"] != "VERIFICATION":
        return
    client = mocks.get_client(app["client_id"])
    enr, lines = mocks.collect(client, bool(app["statement_uploaded"]), st["bureau_mode"],
                               backoff=0.2 if st["step_delay"] > 0 else 0.0)
    with db.tx() as c:
        app = load(c, app_id)
        if app["status"] != "VERIFICATION":
            return
        for line in lines:
            log(c, app_id, "system", "source", line, "bank")
        dec = pol.evaluate(app, client, enr, st["key_rate"], st["decision_mode"])
        if dec["outcome"] == "decline" and dec.get("stage") in ("stop-rule", "eligibility"):
            move(c, app, "DECLINED", "system", "Отказано по результатам проверки данных", "client",
                 bank_message=f"Сработало правило: {', '.join(h['id'] for h in dec['stops']) or dec['reasons'][0]['code']}",
                 enrichment=enr, decision=dec, final_reason=dec["reasons"][0]["code"])
        elif not dec["bureau_ok"]:
            move(c, app, "MANUAL_REVIEW", "system", "Заявку рассматривает специалист банка", "client",
                 bank_message="БКИ недоступно после повторов — заявка передана аналитику (деградация вместо отказа)",
                 enrichment=enr, decision=dec)
        else:
            move(c, app, "DECISIONING", "system", "Данные проверены, оцениваем условия", "client", enrichment=enr)


def step_decide(app_id: str) -> None:
    st = db.runtime_settings()
    _sleep(st["step_delay"])
    with db.tx() as c:
        app = load(c, app_id)
        if app["status"] != "DECISIONING":
            return
        client = mocks.get_client(app["client_id"])
        dec = pol.evaluate(app, client, app["enrichment"], st["key_rate"], st["decision_mode"])
        info = f"Балл {dec.get('score')}, грейд {dec.get('grade')}, решение: {dec['outcome']}"
        log(c, app_id, "system", "decision", info, "bank", data={"outcome": dec["outcome"]})
        if dec["outcome"] in ("approve", "counter"):
            kind = dec["recommendation"]["type"]
            msg = {"AS_REQUESTED": "Предложение готово", "DOWNSELL": "Предложение готово: другой продукт"}.get(kind, "Предложение готово: другие условия")
            move(c, app, "OFFER_READY", "system", msg, "client", decision=dec, offer=dec["recommendation"])
        elif dec["outcome"] == "manual":
            move(c, app, "MANUAL_REVIEW", "system", "Заявку рассматривает специалист банка", "client",
                 bank_message="Ручной разбор: " + "; ".join(dec["manual_reasons"]), decision=dec)
        else:
            move(c, app, "DECLINED", "system", "Отказано", "client", decision=dec, final_reason=dec["reasons"][0]["code"])


def step_disburse(app_id: str) -> None:
    _sleep(_delay())
    with db.tx() as c:
        app = load(c, app_id)
        if app["status"] != "DISBURSING":
            return
        o = app["offer"]
        number = f"КД-2026-{app['seq']:06d}"
        client = mocks.get_client(app["client_id"])
        first = None
        if o["payment"]:
            first = {"date": (date.today() + timedelta(days=30)).isoformat(), "amount": o["payment"]}
        contract = {"number": number, "date": date.today().isoformat(), "account": client["account"],
                    "amount": o["amount"], "rate": o["rate"], "term": o["term"], "first_payment": first,
                    "schedule_start": date.today().isoformat(), "payments": [], "repaid": False,
                    "note": "Моделируемая выдача: реальных денежных операций нет"}
        if o["payment"]:                                            # аннуитет: сумма зачисляется на счёт; лимит овердрафта — не деньги, а право
            _balance(c, app["client_id"])
            c.execute("UPDATE accounts SET balance=balance+? WHERE client_id=?", (o["amount"], app["client_id"]))
            bank_msg = f"Зачисление {o['amount']:,} ₽ на счёт {client['account']} (мок)".replace(",", " ")
        else:
            bank_msg = f"Открыт лимит {o['amount']:,} ₽ по счёту {client['account']} (мок), деньги не зачисляются".replace(",", " ")
        title = f"Кредит выдан. Договор {number}" if o["payment"] else f"Лимит овердрафта открыт. Договор {number}"
        move(c, app, "DISBURSED", "system", title, "client", bank_message=bank_msg, contract=contract)


# ---------- действия клиента ----------

def _own(c, user: dict, app_id: str) -> dict:
    app = load(c, app_id)
    if app["client_id"] != user["client_id"]:
        raise ServiceError(404, "Заявка не найдена")           # изоляция данных: чужую заявку не показываем
    return app


def validate_request(user: dict, product: str, amount: int, term: int, collateral: str) -> dict:
    """Границы продукта, обеспечение и допуск клиента — одни и те же правила для заявки и для расчёта «что если»."""
    prod = policy()["products"].get(product)
    if not prod:
        raise ServiceError(422, "Неизвестный продукт")
    client = mocks.get_client(user["client_id"])
    if not prod["min_amount"] <= amount <= prod["max_amount"]:
        raise ServiceError(422, f"Сумма для продукта: от {prod['min_amount']:,} до {prod['max_amount']:,} ₽".replace(",", " "))
    if not prod["min_term"] <= term <= prod["max_term"]:
        raise ServiceError(422, f"Срок для продукта: от {prod['min_term']} до {prod['max_term']} мес.")
    if collateral not in prod["collateral"]:
        raise ServiceError(422, "Для продукта недоступен выбранный вид обеспечения")
    if prod.get("needs_msp_priority") and not (client["msp_registry"] and client["priority_industry"]):
        raise ServiceError(422, "Льготная программа недоступна для вашей компании")
    return prod


def create_application(user: dict, body: dict, idem_key: str | None) -> str:
    amount, term, collateral = int(body["amount"]), int(body["term"]), body.get("collateral", "none")
    validate_request(user, body["product"], amount, term, collateral)
    consents = body.get("consents") or {}
    if not all(consents.get(k) for k in ("pd", "bureau", "fns")):
        raise ServiceError(422, "Нужны согласия на обработку данных, запрос в БКИ и в ФНС")
    with db.tx() as c:
        if idem_key:
            r = c.execute("SELECT app_id FROM idempotency WHERE key=? AND login=?", (idem_key, user["login"])).fetchone()
            if r:
                return r["app_id"]
        active = c.execute("SELECT id FROM applications WHERE client_id=? AND status NOT IN ('DISBURSED','DECLINED','WITHDRAWN','EXPIRED')",
                           (user["client_id"],)).fetchone()
        if active:
            raise ServiceError(409, f"У вас уже есть активная заявка {active['id']}")
        seq = (c.execute("SELECT COALESCE(MAX(seq),0) m FROM applications").fetchone()["m"]) + 1
        app_id = f"ALF-{seq:06d}"
        ts = db.now()
        c.execute("""INSERT INTO applications(id,seq,client_id,product,amount,term,purpose,purpose_text,collateral,status,created,updated,consents)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (app_id, seq, user["client_id"], body["product"], amount, term, body.get("purpose"),
                   (body.get("purpose_text") or "")[:500], collateral, "DRAFT", ts, ts,
                   db.dumps({**consents, "at": ts, "type": "ПЭП (клик + код)"})))
        if idem_key:
            c.execute("INSERT INTO idempotency(key,login,app_id) VALUES(?,?,?)", (idem_key, user["login"], app_id))
        log(c, app_id, user["login"], "created", "Заявка создана", "client")
        app = load(c, app_id)
        move(c, app, "VERIFICATION", user["login"], "Заявка отправлена. Проверяем данные", "client")
    kick(app_id)
    return app_id


def client_accept(user: dict, app_id: str) -> None:
    expired = False
    with db.tx() as c:
        app = _own(c, user, app_id)
        if app["status"] != "OFFER_READY":
            raise ServiceError(409, "Предложение недоступно для принятия")
        if datetime.fromisoformat(app["offer"]["valid_until"]) < datetime.now(timezone.utc):
            move(c, app, "EXPIRED", "system", "Срок предложения истёк", "client")
            expired = True                                          # ошибку отдаём ПОСЛЕ коммита, иначе переход откатится
        else:
            code = f"{secrets.randbelow(900000) + 100000}"
            move(c, app, "AWAITING_SIGNATURE", user["login"], "Предложение принято. Договор готов к подписанию", "client", sign_code=code)
    if expired:
        raise ServiceError(409, "Срок предложения истёк — подайте новую заявку")


def client_sign(user: dict, app_id: str, code: str) -> None:
    wrong = False
    with db.tx() as c:
        app = _own(c, user, app_id)
        if app["status"] != "AWAITING_SIGNATURE":
            raise ServiceError(409, "Сейчас подписание недоступно")
        if code.strip() != app["sign_code"]:
            log(c, app_id, user["login"], "sign-failed", "Неверный код подтверждения", "client")
            wrong = True                                            # запись о попытке должна сохраниться — ошибку отдаём после коммита
        else:
            move(c, app, "DISBURSING", user["login"], "Договор подписан (простая ЭП — имитация)", "client")
    if wrong:
        raise ServiceError(422, "Неверный код подтверждения")
    kick(app_id)


def client_withdraw(user: dict, app_id: str, message: str = "Заявка отозвана клиентом") -> None:
    with db.tx() as c:
        app = _own(c, user, app_id)
        if app["status"] in TERMINAL or app["status"] == "DISBURSING":
            raise ServiceError(409, "Заявку уже нельзя отозвать")
        move(c, app, "WITHDRAWN", user["login"], message, "client")


def client_docs(user: dict, app_id: str, body: dict) -> None:
    with db.tx() as c:
        app = _own(c, user, app_id)
        if app["status"] != "AWAITING_DOCS":
            raise ServiceError(409, "Документы сейчас не запрашивались")
        req = dict(app["doc_request"] or {}, done=True, note=(body.get("note") or "")[:300])
        move(c, app, "VERIFICATION", user["login"], "Документы получены. Проверяем повторно", "client",
             bank_message="Клиент подключил выписку другого банка (мок). Повторная проверка источников",
             doc_request=req, statement_uploaded=1)
    kick(app_id)


# ---------- действия аналитика ----------

def analyst_decide(user: dict, app_id: str, body: dict) -> None:
    action = body.get("action")
    comment = (body.get("comment") or "").strip()
    with db.tx() as c:
        app = load(c, app_id)
        if app["status"] != "MANUAL_REVIEW":
            raise ServiceError(409, "Заявка не находится на ручном разборе")
        dec = app["decision"] or {}
        actor = f"{user['login']} (аналитик)"
        stamp = {"by": user["login"], "action": action, "comment": comment, "at": db.now()}
        if action == "request_docs":
            if not comment:
                raise ServiceError(422, "Укажите, что нужно от клиента")
            req = {"text": comment, "items": ["Выписка по расчётному счёту из другого банка"], "requested_by": user["login"], "done": False}
            move(c, app, "AWAITING_DOCS", actor, "Нужны документы: " + comment, "client", doc_request=req,
                 decision=dict(dec, analyst=stamp))
        elif action == "decline":
            codes = [x for x in body.get("reasons", []) if x in REASONS]
            if not codes:
                raise ServiceError(422, "Выберите хотя бы одну причину из справочника")
            reasons = [reason(x) for x in codes]
            move(c, app, "DECLINED", actor, "Отказано", "client", bank_message="Отказ аналитика: " + ", ".join(codes) + (f". {comment}" if comment else ""),
                 decision=dict(dec, analyst=stamp, final_reasons=reasons), final_reason=codes[0])
        elif action == "approve":
            rec = dec.get("recommendation") or {}
            product = rec.get("product", app["product"])
            prod = policy()["products"][product]
            amount = int(body.get("amount") or rec.get("amount") or app["amount"])
            term = int(body.get("term") or rec.get("term") or app["term"])
            if not prod["min_amount"] <= amount <= prod["max_amount"] or not prod["min_term"] <= term <= prod["max_term"]:
                raise ServiceError(422, "Сумма или срок вне границ продукта")
            if amount > app["amount"]:
                raise ServiceError(422, f"Нельзя одобрить больше, чем запросил клиент ({_rub(app['amount'])})")
            grade = dec.get("grade") or "C"
            st = db.runtime_settings()
            kind = "DOWNSELL" if product != app["product"] else "AS_REQUESTED" if (amount, term) == (app["amount"], app["term"]) else "COUNTER"
            offer = pol._offer_terms(product, grade, amount, term, rec.get("collateral", app["collateral"]), True, st["key_rate"], kind)
            pmax = (dec.get("afford") or {}).get("p_max")
            if offer["payment"] and pmax is not None and offer["payment"] > pmax and not comment:
                raise ServiceError(422, f"Платёж выше расчётного максимума ({int(pmax):,} ₽) — нужен комментарий".replace(",", " "))
            offer["second_approver_required"] = amount > policy()["second_approver_over"]
            offer["analyst_approved"] = True
            final = pol.helped_reasons({"factors": dec.get("factors", [])})
            move(c, app, "OFFER_READY", actor, "Предложение готово" if offer["type"] == "AS_REQUESTED" else "Предложение готово: другие условия",
                 "client", bank_message=f"Одобрено аналитиком: {amount:,} ₽ на {term} мес. под {offer['rate']}%".replace(",", " ")
                 + (f". {comment}" if comment else ""), offer=offer, decision=dict(dec, analyst=stamp, final_reasons=final))
        else:
            raise ServiceError(422, "Неизвестное действие")


# ---------- представления ----------

def _events(c, app_id: str, bank: bool) -> list[dict]:
    q = "SELECT * FROM events WHERE app_id=? " + ("" if bank else "AND vis IN ('both','client') ") + "ORDER BY id"
    return [{"ts": r["ts"], "actor": r["actor"], "kind": r["kind"], "message": r["message"], "from": r["from_status"],
             "to": r["to_status"], "vis": r["vis"]} for r in c.execute(q, (app_id,))]


def _status_view(app: dict) -> dict:
    title, text, step, turn = CLIENT_VIEW[app["status"]]
    if app["status"] == "AWAITING_DOCS" and app.get("doc_request"):
        text = f"{app['doc_request']['text']}. Закройте пункты в списке «Что нужно от вас»."
    nxt, need, eta = CLIENT_HINTS[app["status"]]
    if app["status"] == "DISBURSED" and (app.get("contract") or {}).get("repaid"):
        title, text, nxt, need = "Кредит погашен", "Все платежи по графику внесены. Спасибо!", "При необходимости оформите новый кредит", "—"
    return {"code": app["status"], "title": title, "text": text, "step": step, "turn": turn, "next": nxt, "need": need, "eta": eta,
            "transient": app["status"] in TRANSIENT, "terminal": app["status"] in TERMINAL}


def _schedule(app: dict) -> list[dict] | None:
    o, ct = app.get("offer"), app.get("contract")
    if not (o and o.get("payment") and app["status"] in ("OFFER_READY", "AWAITING_SIGNATURE", "DISBURSING", "DISBURSED")):
        return None
    start = date.fromisoformat(ct["schedule_start"]) if ct and ct.get("schedule_start") else None   # после выдачи даты не «плывут»
    rows = pricing.schedule(o["amount"], o["rate"], o["term"], start)
    paid = {p["n"]: p for p in (ct or {}).get("payments", [])}
    for r in rows:
        r["paid"] = r["n"] in paid
        r["paid_at"] = paid[r["n"]]["paid_at"] if r["n"] in paid else None
    return rows


def _rub(n: float) -> str:
    return f"{round(n):,}".replace(",", " ") + " ₽"


def loan_summary(app: dict) -> dict | None:
    """Состояние выданного кредита: остаток долга, прогресс, ближайший платёж (посткредитный модуль — необязательный)."""
    rows = _schedule(app)
    if not rows or app["status"] != "DISBURSED":
        return None
    paid = [r for r in rows if r["paid"]]
    nxt = next((r for r in rows if not r["paid"]), None)
    amount = app["offer"]["amount"]
    outstanding = paid[-1]["balance"] if paid else amount
    return {"app_id": app["id"], "contract": app["contract"]["number"], "product_title": app["offer"]["product_title"], "amount": amount,
            "rate": app["offer"]["rate"], "outstanding": outstanding, "progress": round(1 - outstanding / amount, 4),
            "paid_count": len(paid), "total_count": len(rows), "total_paid": sum(r["payment"] for r in paid),
            "interest_paid": sum(r["interest"] for r in paid), "total_interest": sum(r["interest"] for r in rows),
            "next_payment": {"n": nxt["n"], "date": nxt["date"], "amount": nxt["payment"]} if nxt else None, "repaid": nxt is None}


# ---------- расчётный счёт (демо) и платежи ----------

def _balance(c, client_id: str) -> int:
    r = c.execute("SELECT balance FROM accounts WHERE client_id=?", (client_id,)).fetchone()
    if r is None:
        bal = mocks.get_client(client_id)["start_balance"]
        c.execute("INSERT INTO accounts(client_id, balance) VALUES(?,?)", (client_id, bal))
        return bal
    return r["balance"]


def account_view(client_id: str) -> dict:
    """Баланс счёта: читаем без блокировки записи; строка создаётся (со стартовым остатком) только при первом обращении."""
    with db.read() as c:
        r = c.execute("SELECT balance FROM accounts WHERE client_id=?", (client_id,)).fetchone()
    if r is None:
        with db.tx() as c:
            bal = _balance(c, client_id)
    else:
        bal = r["balance"]
    return {"number": mocks.get_client(client_id)["account"], "balance": bal}


def account_topup(user: dict, amount: int) -> dict:
    """Демо-пополнение расчётного счёта (реальных операций нет)."""
    with db.tx() as c:
        _balance(c, user["client_id"])
        c.execute("UPDATE accounts SET balance=balance+? WHERE client_id=?", (amount, user["client_id"]))
    return account_view(user["client_id"])


def pay_next(user: dict, app_id: str) -> dict:
    """Оплата ближайшего платежа по графику со счёта клиента (моделируется). Статус заявки не меняется."""
    with db.tx() as c:
        app = _own(c, user, app_id)
        rows = _schedule(app)
        if app["status"] != "DISBURSED" or not rows:
            raise ServiceError(409, "По этой заявке нет графика платежей")
        nxt = next((r for r in rows if not r["paid"]), None)
        if nxt is None:
            raise ServiceError(409, "Кредит уже погашен")
        bal = _balance(c, user["client_id"])
        if bal < nxt["payment"]:
            raise ServiceError(422, f"Недостаточно средств на счёте: нужно {_rub(nxt['payment'])}, доступно {_rub(bal)}. Пополните счёт.")
        c.execute("UPDATE accounts SET balance=balance-? WHERE client_id=?", (nxt["payment"], user["client_id"]))
        ct = app["contract"]
        ct["payments"].append({"n": nxt["n"], "paid_at": db.now(), "amount": nxt["payment"]})
        ct["repaid"] = nxt["n"] == len(rows)
        cur = c.execute("UPDATE applications SET contract=?, updated=?, version=version+1 WHERE id=? AND version=?",
                        (db.dumps(ct), db.now(), app_id, app["version"]))
        if cur.rowcount != 1:
            raise ServiceError(409, "Заявка изменилась, обновите страницу")
        log(c, app_id, user["login"], "payment", f"Платёж №{nxt['n']} на {_rub(nxt['payment'])} оплачен со счёта", "both")
        if ct["repaid"]:
            log(c, app_id, "system", "repaid", "Кредит полностью погашен", "both")
        app["contract"], app["version"] = ct, app["version"] + 1
        return {"loan": loan_summary(app), "balance": _balance(c, user["client_id"])}


COLLATERAL_LABELS = {"none": "Без обеспечения", "equipment": "Залог приобретаемого оборудования или транспорта", "realty": "Залог недвижимости"}
COLLATERAL_HINTS = {
    "none": "Кредит без залога и поручителей; ставка выше, чем при наличии обеспечения.",
    "guarantor": "Поручитель отвечает по кредиту вместе с компанией. Это снижает риск банка и ставку.",
    "equipment": "Приобретаемое оборудование или транспорт остаётся в залоге у банка до погашения. Снижает ставку.",
    "realty": "Недвижимость остаётся в залоге у банка до погашения. Сильнее всего снижает ставку.",
}


def collateral_options(client_id: str | None, allowed: list[str]) -> list[dict]:
    """Названия обеспечения зависят от формы бизнеса: у ИП нет «собственников», поэтому — поручительство третьего лица."""
    legal = mocks.get_client(client_id)["legal_form"] if client_id else "ООО"
    labels = dict(COLLATERAL_LABELS, guarantor="Поручительство бенефициарного владельца бизнеса" if legal == "ООО" else "Поручительство третьего лица")
    return [{"id": c, "label": labels[c], "hint": COLLATERAL_HINTS[c]} for c in allowed]


def collateral_label(client_id: str, code: str) -> str:
    return next(o["label"] for o in collateral_options(client_id, [code]))


_INTERNAL_OFFER_KEYS = {"grade", "second_approver_required", "analyst_approved"}


def _client_offer(offer: dict | None) -> dict | None:
    """Клиент видит условия, но не внутренний грейд риска и служебные пометки банка."""
    return {k: v for k, v in offer.items() if k not in _INTERNAL_OFFER_KEYS} if offer else offer


def client_view(c, app: dict) -> dict:
    prod = policy()["products"][app["product"]]
    dec = app.get("decision") or {}
    reasons = dec.get("final_reasons") or dec.get("reasons") or []
    if app["status"] == "MANUAL_REVIEW":                       # клиенту не раскрываем, какие данные не удалось получить
        reasons = [r for r in reasons if r["code"] == "R18"]
    show = app["status"] in ("OFFER_READY", "AWAITING_SIGNATURE", "DISBURSING", "DISBURSED", "DECLINED", "MANUAL_REVIEW", "EXPIRED", "WITHDRAWN")
    return {
        "id": app["id"], "product": app["product"], "product_title": prod["title"], "amount": app["amount"], "term": app["term"],
        "collateral": app["collateral"], "purpose": app["purpose"], "purpose_text": app["purpose_text"],
        "created": app["created"], "updated": app["updated"], "status": _status_view(app), "steps": STEPS,
        "offer": _client_offer(app["offer"]) if app["status"] not in ("DECLINED",) else None,
        "collateral_label": collateral_label(app["client_id"], app["offer"]["collateral"] if app["offer"] else app["collateral"]),
        "collateral_label_requested": collateral_label(app["client_id"], app["collateral"]),
        "loan": loan_summary(app),
        "reasons": reasons if show else [], "doc_request": app["doc_request"],
        "contract": app["contract"], "schedule": _schedule(app),
        "sign_code": app["sign_code"] if app["status"] == "AWAITING_SIGNATURE" else None,
        "events": _events(c, app["id"], bank=False),
        "automated": True,
    }


def mask_inn(inn: str) -> str:
    return inn[:4] + "•" * (len(inn) - 6) + inn[-2:]


_LIST_COLS = "id, seq, client_id, product, amount, term, status, created, updated, decision, doc_request, contract"   # без enrichment/offer/consents


def list_for_client(c, user: dict) -> list[dict]:
    rows = c.execute(f"SELECT {_LIST_COLS} FROM applications WHERE client_id=? ORDER BY seq DESC", (user["client_id"],)).fetchall()
    out = []
    for r in rows:
        a = db.row_to_app(r)
        out.append({"id": a["id"], "product_title": policy()["products"][a["product"]]["title"], "amount": a["amount"],
                    "term": a["term"], "created": a["created"], "updated": a["updated"], "status": _status_view(a)})
    return out


def bank_row(app: dict) -> dict:
    cl = mocks.get_client(app["client_id"])
    dec = app.get("decision") or {}
    return {"id": app["id"], "client": cl["name"], "inn": mask_inn(cl["inn"]), "product_title": policy()["products"][app["product"]]["title"],
            "amount": app["amount"], "term": app["term"], "status": app["status"], "status_title": CLIENT_VIEW[app["status"]][0],
            "turn": CLIENT_VIEW[app["status"]][3], "score": dec.get("score"), "grade": dec.get("grade"),
            "outcome": dec.get("outcome"), "created": app["created"], "updated": app["updated"]}


def bank_list(c) -> list[dict]:
    return [bank_row(db.row_to_app(r)) for r in c.execute(f"SELECT {_LIST_COLS} FROM applications ORDER BY seq DESC")]


def bank_view(c, app: dict) -> dict:
    cl = mocks.get_client(app["client_id"])
    enr = app.get("enrichment")
    summary = {k: cl[k] for k in ("name", "legal_form", "inn", "ogrn", "okved", "director", "address", "registered", "tax_regime",
                                  "account", "receipts", "existing_payments")}
    return {**bank_row(app), "request": {"product": app["product"], "amount": app["amount"], "term": app["term"], "collateral": app["collateral"],
                                         "purpose": app["purpose"], "purpose_text": app["purpose_text"]},
            "client_info": summary, "enrichment": enr, "decision": app.get("decision"), "offer": app.get("offer"),
            "doc_request": app.get("doc_request"), "consents": app.get("consents"), "contract": app.get("contract"),
            "events": _events(c, app["id"], bank=True), "version": app["version"],
            "reason_catalog": {k: v[0] for k, v in REASONS.items()}, "can_decide": app["status"] == "MANUAL_REVIEW",
            "status_view": _status_view(app)}


def stats(c) -> dict:
    by = {r["status"]: r["n"] for r in c.execute("SELECT status, COUNT(*) n FROM applications GROUP BY status")}
    return {"total": sum(by.values()), "by_status": by, "manual_queue": by.get("MANUAL_REVIEW", 0),
            "waiting_client": by.get("AWAITING_DOCS", 0) + by.get("OFFER_READY", 0) + by.get("AWAITING_SIGNATURE", 0),
            "disbursed": by.get("DISBURSED", 0), "declined": by.get("DECLINED", 0)}


def client_enrichment(user: dict) -> tuple[dict, dict, dict]:
    st = db.runtime_settings()
    cl = mocks.get_client(user["client_id"])
    enr, _ = mocks.collect(cl, False, st["bureau_mode"])
    return cl, enr, st
