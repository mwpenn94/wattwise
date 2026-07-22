#!/usr/bin/env python3
"""NAT-3: Distill the OpenEI URDB bulk CSV into a compact nationwide seed of
filed-quality electric rates.

Selection rules (conservative, provenance-honest):
- sector Residential or Commercial, servicetype != Lighting
- active (no enddate), approved snapshot (bulk file only contains published rates)
- has usable energy rate structure (energyratestructure period0 tier0 rate)
- prefer is_default=1 rates; fall back to the most-recently-updated active rate
- one residential + one commercial rate per utility (EIA ID)
- utilities ranked by number of states/zip3s they cover in our registry is done
  TS-side; here we distill ALL utilities with usable defaults, TS chooses.

Output: server/seed/urdbDistilled.json
  [{eiaid, utility, sector, label, name, startdate, fixedMonthly, energyRates:
    [{label, ratePerUnit, maxUsage}], demandNote, tou: bool, sourceUrl}]
"""
import csv
import json
import sys
from collections import defaultdict

csv.field_size_limit(sys.maxsize)

SRC = "/tmp/usurdb.csv"
OUT = "/home/ubuntu/wattwise/server/seed/urdbDistilled.json"

def f(row, key):
    v = row.get(key, "")
    return v.strip() if v else ""

def num(row, key):
    v = f(row, key)
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None

candidates = defaultdict(list)  # (eiaid, sector) -> [rate dict]

with open(SRC, newline="", encoding="utf-8", errors="replace") as fh:
    reader = csv.DictReader(fh)
    for row in reader:
        sector = f(row, "sector")
        if sector not in ("Residential", "Commercial"):
            continue
        if f(row, "enddate"):
            continue  # closed rate
        if f(row, "servicetype") == "Lighting":
            continue
        eiaid = f(row, "eiaid")
        if not eiaid:
            continue
        # need at least one usable energy rate
        r0 = num(row, "energyratestructure/period0/tier0rate")
        if r0 is None or r0 <= 0 or r0 > 2:
            continue
        # collect tiers of period 0 (flat or first TOU period) up to 4 tiers
        tiers = []
        for t in range(4):
            rate = num(row, f"energyratestructure/period0/tier{t}rate")
            if rate is None:
                break
            adj = num(row, f"energyratestructure/period0/tier{t}adj") or 0.0
            mx = num(row, f"energyratestructure/period0/tier{t}max")
            tiers.append({"ratePerUnit": round(rate + adj, 6), "maxUsage": mx})
        # detect TOU: a second period present
        tou = num(row, "energyratestructure/period1/tier0rate") is not None
        # period1 first tier (for TOU average context)
        p1 = num(row, "energyratestructure/period1/tier0rate")
        fixed = num(row, "fixedchargefirstmeter") or 0.0
        fixed_units = f(row, "fixedchargeunits") or "$/month"
        if fixed_units == "$/day":
            fixed_monthly = round(fixed * 30.4, 2)
        elif fixed_units == "$/month" or fixed_units == "":
            fixed_monthly = round(fixed, 2)
        else:
            fixed_monthly = round(fixed, 2)  # rare units; keep as-is, note below
        has_demand = bool(f(row, "demandrateunit") or num(row, "demandratestructure/period0/tier0rate") is not None or num(row, "flatdemandstructure/period0/tier0rate") is not None)
        candidates[(eiaid, sector)].append({
            "label": f(row, "label"),
            "eiaid": eiaid,
            "utility": f(row, "utility"),
            "sector": sector,
            "name": f(row, "name"),
            "isDefault": f(row, "is_default") in ("1", "True", "true"),
            "startdate": f(row, "startdate")[:10],
            "latestUpdate": f(row, "latest_update")[:10],
            "fixedMonthly": fixed_monthly,
            "fixedUnits": fixed_units,
            "tiers": tiers,
            "tou": tou,
            "p1Rate": p1,
            "hasDemand": has_demand,
            "servicetype": f(row, "servicetype"),
            "source": f(row, "source"),
        })

import re

BAD_NAME = re.compile(r"traffic|lighting|light\b|watt.?hour|unmetered|standby|space.?heat|water.?heat|irrigation|pump|outdoor|athletic|dusk|EV|electric vehicle|experimental|pilot|closed|frozen|employee|net meter|interconnect", re.I)
GOOD_COMM = re.compile(r"general service|small general|small commercial|\bGS\b|schedule gs|small business|commercial service|business service", re.I)
GOOD_RES = re.compile(r"residential service|\bRS\b|schedule r\b|res\.? service|residential rate|standard residential", re.I)
DELIVERY_ONLY = re.compile(r"delivery(?! with standard offer)|distribution only|unbundled|supply.{0,20}separate", re.I)

def recency(c):
    return c["latestUpdate"] or c["startdate"] or ""

def score(c):
    name = c["name"]
    fresh = recency(c) >= "2023-01-01"
    good_name = bool(GOOD_COMM.search(name)) if c["sector"] == "Commercial" else bool(GOOD_RES.search(name))
    plausible_rate = c["tiers"][0]["ratePerUnit"] >= 0.06
    # In deregulated markets a utility publishes both a bare "Delivery" rate
    # and "Delivery with Standard Offer" (delivery + default supply = the
    # actual all-in price a non-shopping customer pays). Prefer the all-in.
    st = c.get("servicetype", "")
    st_rank = 2 if st == "Delivery with Standard Offer" else (0 if st == "Delivery" else 1)
    return (
        0 if BAD_NAME.search(name) else 1,
        st_rank,
        1 if plausible_rate else 0,
        1 if fresh else 0,
        1 if c["isDefault"] else 0,
        1 if good_name else 0,
        0 if c["hasDemand"] else 1,
        0 if c["tou"] else 1,
        recency(c),
    )

picked = []
for (eiaid, sector), lst in candidates.items():
    lst.sort(key=score, reverse=True)
    best = lst[0]
    # drop picks that are still bad after best-effort: bad name or implausible rate
    if BAD_NAME.search(best["name"]):
        continue
    if best["tiers"][0]["ratePerUnit"] < 0.03:
        continue
    best["candidateCount"] = len(lst)
    best["stale"] = recency(best) < "2023-01-01"
    st = best.get("servicetype", "")
    best["deliveryOnly"] = (
        st == "Delivery"
        or (st != "Delivery with Standard Offer" and (bool(DELIVERY_ONLY.search(best["name"])) or best["tiers"][0]["ratePerUnit"] < 0.07))
    )
    picked.append(best)

print(f"utilities with residential: {sum(1 for p in picked if p['sector']=='Residential')}")
print(f"utilities with commercial:  {sum(1 for p in picked if p['sector']=='Commercial')}")
print(f"total picked rates: {len(picked)}")

with open(OUT, "w") as fh:
    json.dump(picked, fh, separators=(",", ":"))
print(f"wrote {OUT}")
