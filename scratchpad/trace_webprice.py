#!/usr/bin/env python3
"""
trace_webprice.py — Test LOGIC web-pricing (PriceWebLookupService) không cần chạy server.
Gọi thẳng Gemini REST (v1beta, gemini-2.5-flash + google_search) cho từng công tác
của bảng ⚡ bóc, rồi áp đúng 3 rào chống bịa như service. In ra chỗ nào fail.

Usage: python trace_webprice.py [Tỉnh]   (mặc định "TP. Hồ Chí Minh")
"""
import json, sys, re, urllib.request, urllib.error
from pathlib import Path

try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

API = Path(__file__).resolve().parent.parent
KEY = None
for line in (API / ".env").read_text(encoding="utf-8").splitlines():
    if line.startswith("GEMINI_API_KEY="):
        KEY = line.split("=", 1)[1].strip().strip('"')
MODEL = "gemini-2.5-flash"
PROVINCE = sys.argv[1] if len(sys.argv) > 1 else "TP. Hồ Chí Minh"

# 9 công tác đúng như output ⚡ bóc KT
WORKS = [
    ("Xây tường", "m3"), ("Xây/trát tường", "m2"), ("Bả + sơn tường", "m2"),
    ("Len/chân tường", "m"), ("Cửa đi", "m2"), ("Cửa sổ", "m2"),
    ("Lát nền", "m2"), ("Trần", "m2"), ("Sơn trần", "m2"),
]

PRICE_MIN, PRICE_MAX = 1_000, 100_000_000


def post(model, body):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={KEY}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"error": {"code": e.code, "message": e.read().decode()[:200]}}
    except Exception as e:
        return {"error": {"code": "EXC", "message": str(e)[:200]}}


def normalize_work(w):
    w = re.sub(r"\([^)]*\)", " ", w.lower())
    w = re.sub(r"(\w+)\s*/\s*\w+", r"\1", w)  # xây/trát tường -> xây tường
    return re.sub(r"\s+", " ", w).strip()


def price_in_text(vnd, text):
    d = str(round(vnd))
    grp = re.sub(r"\B(?=(\d{3})+(?!\d))", "#", d)
    variants = [d, grp.replace("#", "."), grp.replace("#", ","), grp.replace("#", " ")]
    t = re.sub(r"\s+", " ", text)
    return any(v in t for v in variants)


def research(query):
    r = post(MODEL, {"contents": [{"parts": [{"text": query}]}], "tools": [{"google_search": {}}]})
    if "error" in r:
        return None, [], r["error"]
    c = (r.get("candidates") or [{}])[0]
    text = "".join(p.get("text", "") for p in c.get("content", {}).get("parts", []))
    chunks = c.get("groundingMetadata", {}).get("groundingChunks", [])
    src = [(ch.get("web", {}).get("title"), ch.get("web", {}).get("uri")) for ch in chunks if ch.get("web")]
    return text, src, None


def extract(text, wn, unit):
    prompt = (f'Từ đoạn văn sau, trích ĐƠN GIÁ thi công công tác "{wn}" đơn vị {unit} bằng VNĐ. '
              f'Trả JSON {{"found":bool,"unitPriceVnd":number,"rawPrice":string}}. '
              f'unitPriceVnd = con số (khoảng thì lấy mức phổ biến), rawPrice = chuỗi giá nguyên văn. '
              f'Không thấy → found=false. Không bịa.\n\n--- ĐOẠN VĂN ---\n{text}')
    r = post(MODEL, {"contents": [{"parts": [{"text": prompt}]}],
                     "generationConfig": {"responseMimeType": "application/json"}})
    if "error" in r:
        return None
    try:
        t = "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"])
        return json.loads(t)
    except Exception:
        return None


def main():
    if not KEY:
        print("NO GEMINI_API_KEY"); return
    print(f"Model={MODEL}  Tỉnh={PROVINCE}\n")
    hit = 0
    for name, unit in WORKS:
        wn = normalize_work(name)
        q = (f'Đơn giá thi công (nhân công + vật liệu) công tác "{wn}" tại {PROVINCE} năm 2025, '
             f'đơn vị {unit}, VNĐ. Nêu CON SỐ cụ thể và trích nguồn. Khoảng giá thì lấy mức phổ biến.')
        text, src, err = research(q)
        if err:
            print(f"✗ {name:18} RESEARCH ERROR {err['code']}: {err['message'][:80]}")
            continue
        if not src or not text:
            print(f"✗ {name:18} fail=grounding (sources=0)")
            continue
        ex = extract(text, wn, unit)
        if not ex or not ex.get("found"):
            print(f"✗ {name:18} sources={len(src)} fail=not-found (extract không ra giá)")
            continue
        price = ex.get("unitPriceVnd")
        if not (isinstance(price, (int, float)) and PRICE_MIN <= price <= PRICE_MAX):
            print(f"✗ {name:18} sources={len(src)} fail=range (price={price})")
            continue
        if not price_in_text(price, text):
            print(f"✗ {name:18} sources={len(src)} fail=literal (price={price} không có nguyên văn trong text; raw='{ex.get('rawPrice')}')")
            continue
        hit += 1
        print(f"✓ {name:18} = {price:,.0f} đ/{unit}  nguồn: {src[0][0]}  (raw='{ex.get('rawPrice')}')")
    print(f"\n=> {hit}/{len(WORKS)} công tác lấy được giá.")
    if hit == 0:
        print("Nếu toàn bộ fail=grounding → key/model không ground trên prod. Nếu chạy được ở đây mà prod trống → prod chưa deploy code / env sai.")


if __name__ == "__main__":
    main()
