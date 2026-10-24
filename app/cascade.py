"""Каскад по продуктам на PD-модели: автоодобрение / серая зона / пропуск продукта.

Для каждого продукта задано два порога PD (config/products.yaml → ml.cutoffs):
    PD ≤ approve          → автоодобрение этого продукта
    approve < PD < decline → серая зона: пробуем более безопасные продукты каскада, иначе — живой верификатор
    PD ≥ decline          → продукт пропускается («skip»): пробуем следующий продукт каскада, иначе отказ
PD считается для конкретного предложения (клиент + продукт + сумма + срок), поэтому у разных продуктов она разная.
Жёсткие стоп-правила и допуск продукта (policy overlays) стоят ДО модели и модель их не отменяет.
Скоркарта считается параллельно как эталон (champion) и для объяснений; она же — запасной источник PD.
"""
from ml.predict import pd_to_score

from . import policy as pol
from . import pd_provider, scoring
from .config import policy
from .reasons import FACTOR_REASON, reason
from ml.features import FEATURE_REASON


def grade_from_pd(pd_pct: float) -> str:
    cut = policy()["ml"]["grade_pd_cutoffs"]
    for g in ("A", "B", "C", "D"):
        if pd_pct < cut[g]:
            return g
    return "E"


def zone_of(product: str, pd_pct: float) -> str:
    c = policy()["ml"]["cutoffs"][product]
    return "approve" if pd_pct <= c["approve"] else "skip" if pd_pct >= c["decline"] else "grey"


def _calc_grade(g: str) -> str:
    return "D" if g == "E" else g


def _candidate(c: str, app: dict, p: dict, client: dict, provider, key_rate: float) -> dict:
    pc = policy()
    prod = pc["products"][c]
    t = {"product": c, "title": prod["title"], "pd": None, "grade": None, "zone": "skip", "amount": None, "term": None,
         "rate": None, "note": None, "rec": None, "af": None, "result": None}
    elig = pol.eligibility(c, p)
    if elig:
        t["note"] = elig[0]["text"]
        t["elig_reason"] = elig[0]
        return t
    amount0 = min(app["amount"], prod["max_amount"])
    if amount0 < prod["min_amount"]:
        t["note"] = "Сумма ниже минимума продукта"
        return t
    term0 = min(max(app["term"], prod["min_term"]), prod["max_term"])
    col = app["collateral"] if app["collateral"] in prod["collateral"] else prod["collateral"][0]
    kw = dict(collateral=col, legal_form=client["legal_form"])

    # PD зависит от суммы и срока, а сумма и срок — от грейда (DSCR, цена). Ищем согласованную пару итерацией от ИСХОДНОГО
    # запроса: грейд = грейд PD итогового предложения. Если грейд колеблется между двумя значениями — берём более
    # консервативный (последний пересчёт делается уже с ним), поэтому процесс всегда завершается.
    r = provider.predict(p, product=c, amount=amount0, term=term0, **kw)
    grade = grade_from_pd(r.pd * 100)
    seen = [grade]
    rec = af = None
    for _ in range(5):
        rec, af = pol.recommend(c, _calc_grade(grade), p, amount0, term0, col, key_rate, manual=False)
        if rec is None:
            t.update(pd=round(r.pd * 100, 2), grade=grade, result=r, af=af, note="Платёж не проходит по денежному потоку")
            return t
        r = provider.predict(p, product=c, amount=rec["amount"], term=rec["term"], **kw)     # PD конкретного предложения
        g = grade_from_pd(r.pd * 100)
        if g == grade:
            break
        if g in seen:                                                                          # колебание → фиксируем худший грейд
            grade = max(g, grade)                                                              # «A» < «B» < … — лексикографически
            rec, af = pol.recommend(c, _calc_grade(grade), p, amount0, term0, col, key_rate, manual=False)
            if rec is None:
                t.update(pd=round(r.pd * 100, 2), grade=grade, result=r, af=af, note="Платёж не проходит по денежному потоку")
                return t
            r = provider.predict(p, product=c, amount=rec["amount"], term=rec["term"], **kw)
            break
        seen.append(g)
        grade = g
    pd_pct = r.pd * 100
    z = zone_of(c, pd_pct)
    note = None
    if z == "approve" and rec["amount"] > pol.auto_limit(c, grade):
        z, note = "grey", "Сумма выше лимита автоматического решения"
    t.update(pd=round(pd_pct, 2), grade=grade, zone=z, amount=rec["amount"], term=rec["term"], rate=rec["rate"],
             rec=rec, af=af, result=r, note=note, collateral=col)
    return t


def _public(t: dict) -> dict:
    return {k: t.get(k) for k in ("product", "title", "pd", "grade", "zone", "amount", "term", "rate", "note")}


def _ml_hurts(result, limit: int = 3) -> list[dict]:
    out, seen = [], set()
    for feat, v in (result.contributions or []):
        code = FEATURE_REASON.get(feat)
        if v > 0.02 and code and code not in seen:
            seen.add(code)
            out.append(reason(code))
        if len(out) == limit:
            break
    return out


def evaluate_cascade(app: dict, client: dict, enrichment: dict, key_rate: float, provider=None) -> dict:
    pc = policy()
    mlc = pc["ml"]
    provider = provider or pd_provider.get_provider()
    p = scoring.build_profile(client, enrichment)
    sc_stops = scoring.stop_rules(p)
    dec = {"policy_version": pc["version"], "scorecard_version": pol.SCORECARD_VERSION, "key_rate": key_rate, "mode": "ml_cascade",
           "stops": sc_stops, "flags": pol.soft_flags(p, app["amount"]), "bureau_ok": p["bureau_ok"]}
    if sc_stops:
        dec.update(outcome="decline", reasons=[reason(h["code"]) for h in sc_stops[:1]], stage="stop-rule")
        return dec

    sc = scoring.score(p)
    dec.update(factors=sc["factors"], scorecard_score=sc["total"], scorecard_grade=sc["grade"], partial=sc["partial"])

    requested = app["product"]
    candidates = [requested] + mlc["ladder"].get(requested, [])
    manual_reasons = []
    if not p["bureau_ok"]:
        manual_reasons.append("Данные БКИ недоступны")
    if len(dec["flags"]) >= 2:
        manual_reasons.append("Два и более мягких флага риска")

    trace, chosen, first_grey, first_ok = [], None, None, None
    for i, c in enumerate(candidates):
        t = _candidate(c, app, p, client, provider, key_rate)
        trace.append(_public(t))
        if t["rec"] and first_ok is None:
            first_ok = t
        if manual_reasons:
            break
        if t["zone"] == "approve":
            chosen = t
            break
        if t["zone"] == "grey":
            first_grey = first_grey or t
            if mlc["grey_zone"] == "refer":
                break

    ref = chosen or first_grey or first_ok
    res = ref["result"] if ref and ref["result"] else None
    dec["ml"] = {
        "source": res.source if res else provider.status()["source"], "version": res.version if res else provider.status()["version"],
        "grey_zone_policy": mlc["grey_zone"], "trace": trace,
        "cutoffs": {k: mlc["cutoffs"][k] for k in candidates}, "scorecard_pd": round(scoring.pd_fraction(sc["total"]) * 100, 2),
        "contributions": [{"feature": f, "value": round(v, 3)} for f, v in (res.contributions or [])][:6] if res else [],
    }
    if ref and ref["pd"] is not None:
        dec.update(pd=ref["pd"], grade=ref["grade"], score=round(pd_to_score(ref["pd"] / 100)))
    dec["afford"] = ref["af"] if ref else None

    helped = pol.helped_reasons({"factors": sc["factors"]})
    hurts = _ml_hurts(res) if res and res.contributions else pol._hurts(sc)

    def pick(t):
        rec = dict(t["rec"])
        if t["product"] != requested:
            rec["type"] = "DOWNSELL"
        rec["product_title"] = t["title"]
        return rec

    if manual_reasons or (not chosen and first_grey):
        t = first_grey or first_ok
        if not manual_reasons:
            manual_reasons.append(f"PD {t['pd']}% — серая зона продукта «{t['title']}»"
                                  + ("; безопасные продукты каскада не прошли автоотсечку" if len(candidates) > 1 and mlc["grey_zone"] != "refer" else ""))
        rec = None
        if t and t["rec"]:                                  # рекомендация для живого верификатора считается по цене ручного разбора
            rec, _ = pol.recommend(t["product"], _calc_grade(t["grade"]), p, t["rec"]["amount"], t["rec"]["term"], t.get("collateral", app["collateral"]), key_rate, manual=True)
            rec = rec or t["rec"]
            rec = dict(rec, product_title=t["title"]) if t["product"] == requested else dict(rec, type="DOWNSELL", product_title=t["title"])
        dec.update(outcome="manual", manual_reasons=manual_reasons, recommendation=rec, reasons=[reason("R18")] + ([reason("R05")] if not p["bureau_ok"] else []))
        return dec
    if chosen:
        rec = pick(chosen)
        dec["recommendation"] = rec
        if rec["type"] == "AS_REQUESTED":
            dec.update(outcome="approve", reasons=helped[:3])
        elif rec["type"] == "DOWNSELL":
            dec.update(outcome="counter", reasons=[reason("R20", text=f"Запрошенный продукт на таких условиях не подходит; подобрали «{chosen['title']}»: "
                                                          f"{rec['amount']:,} ₽ на {rec['term']} мес.".replace(",", " "))] + hurts[:2])
        else:
            dec.update(outcome="counter", reasons=[reason("R13", text=(f"Запрошенная сумма превышает комфортный платёж; предлагаем {rec['amount']:,} ₽ "
                                                                       f"на {rec['term']} мес.".replace(",", " ")))] + hurts[:2])
        return dec
    # все продукты каскада пропущены
    if all(x["pd"] is None for x in trace):                  # ни для одного продукта не удалось даже посчитать PD
        dec.update(outcome="decline", reasons=pol.eligibility(requested, p)[:1] or [reason("R02")], stage="eligibility")
        return dec
    dec.update(outcome="decline", reasons=[reason("R02")] + (hurts[:2] if res else []), stage="cascade")
    return dec
