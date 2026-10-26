"""Независимая проверка цен и платежей: формулы закодированы заново (по docs/credit-policy.md), без импорта app.pricing."""
import math, sys, json
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from app import pricing, policy, mocks, scoring
from app.config import policy as cfg

K = 14.0
PD = {"A": 1.5, "B": 3.0, "C": 6.0, "D": 11.0, "E": 20.0}
CAP = {"A": .5, "B": .8, "C": 1.2, "D": 1.8, "E": 3.0}
LGD = {"none": 45, "guarantor": 40, "equipment": 35, "realty": 25}
DISC = {"none": 0.0, "guarantor": 0.5, "equipment": 1.0, "realty": 2.0}   # явная скидка за обеспечение, п.п.
PADD = {"working": 0, "overdraft": 1.0, "development": .5}

def ref_rate(prod, g, term, col, manual, k=K):
    if prod == "preferential": return round(k + 3, 2)
    tadd = 0 if term <= 12 else .5 if term <= 36 else 1.0
    raw = k + (1.8 if manual else 1.2) + PD[g] * LGD[col] / 100 + CAP[g] + 1.0 + PADD[prod] + tadd - DISC[col]
    r = math.ceil(round(raw * 2, 9)) / 2
    return min(r, k + 10)

def ref_pmt(S, rate, n):
    i = rate / 1200
    return S * i / (1 - (1 + i) ** -n)

bad, n = [], 0
for prod in ("working", "overdraft", "development", "preferential"):
    for g in "ABCDE":
        for term in (6, 12, 13, 24, 36, 37, 60):
            for col in ("none", "guarantor", "equipment", "realty"):
                for manual in (False, True):
                    n += 1
                    a, b = pricing.rate_for(prod, g, term, col, manual, K), ref_rate(prod, g, term, col, manual)
                    if abs(a - b) > 1e-9: bad.append((prod, g, term, col, manual, a, b))
print(f"ставки: сверено {n} комбинаций, расхождений {len(bad)}", bad[:3])
for k in (10.0, 14.0, 14.25, 16.0, 21.0):
    for g in "ABCD":
        assert pricing.rate_for("working", g, 24, "none", False, k) == ref_rate("working", g, 24, "none", False, k), (k, g)
print("ставки при разной ключевой: OK")

bad = []
for S in (100_000, 500_000, 1_000_000, 3_000_000, 5_000_000, 15_000_000):
    for rate in (14.0, 17.0, 18.0, 19.0, 20.5, 24.0):
        for term in (6, 12, 24, 36, 60):
            pay = pricing.annuity(S, rate, term)
            if abs(pay - ref_pmt(S, rate, term)) > 0.5: bad.append(("pmt", S, rate, term, pay, ref_pmt(S, rate, term)))
            rows = pricing.schedule(S, rate, term)
            if rows[-1]["balance"] != 0 or sum(r["principal"] for r in rows) != S: bad.append(("sched-close", S, rate, term))
            if any(r["payment"] != r["interest"] + r["principal"] for r in rows): bad.append(("sched-sum", S, rate, term))
            if any(r["balance"] < 0 for r in rows): bad.append(("neg-balance", S, rate, term))
            if max(r["payment"] for r in rows[:-1] or rows) - pay > 1: bad.append(("pay-drift", S, rate, term))
            back = pricing.amount_from_payment(ref_pmt(S, rate, term), rate, term)
            if abs(back - S) > 1: bad.append(("inverse", S, rate, term, back))
print(f"аннуитет и график: расхождений {len(bad)}", bad[:3])

# контрольный пример: 3 млн ₽, 24 мес., 19,0 %
rows = pricing.schedule(3_000_000, 19.0, 24)
chk = {"платёж": rows[0]["payment"], "%1": rows[0]["interest"], "осн1": rows[0]["principal"], "ост1": rows[0]["balance"],
       "%2": rows[1]["interest"], "осн2": rows[1]["principal"], "%3": rows[2]["interest"], "осн3": rows[2]["principal"],
       "последний": rows[-1]["payment"], "переплата": sum(r["payment"] for r in rows) - 3_000_000}
print("контрольный пример 3 млн/24/19 %:", chk)
exp = {"платёж": 151226, "%1": 47500, "осн1": 103726, "ост1": 2896274, "%2": 45858, "осн2": 105368, "%3": 44189, "осн3": 107037, "переплата": 629422}
print("совпадение с эталоном:", {k: (chk[k] == v) for k, v in exp.items()})

# политика: P_max и сумма на срок (независимо)
MARG = {"it": .2, "production": .12, "catering": .08, "construction": .08, "transport": .09, "trade": .05}
DSCR = {"A": 1.25, "B": 1.30, "C": 1.40, "D": 1.60, "E": 1.60}; SH = {"A": .30, "B": .25, "C": .20, "D": .15, "E": .10}
for cid, g in (("C-A", "A"), ("C-B", "B"), ("C-C", "C")):
    cl = mocks.get_client(cid); enr, _ = mocks.collect(cl, True, "ok"); p = scoring.build_profile(cl, enr)
    ncf = p["avg"] * MARG[cl["industry"]]
    pm = min(ncf / DSCR[g] - p["existing_payments"], SH[g] * p["avg"] - p["existing_payments"])
    got = policy.afford(p, g)["p_max"]
    print(f"P_max {cid}/{g}: независимо {pm:,.0f} vs приложение {got:,.0f}", "OK" if abs(pm - got) <= 1 else "РАСХОЖДЕНИЕ")
