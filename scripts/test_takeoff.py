#!/usr/bin/env python3
"""
Harness đánh giá AI bóc tách khối lượng (deterministic takeoff engine) của GenSpec
qua NHIỀU bản vẽ khác nhau. Trả lời 3 câu:
  1. Bóc tách ỔN chưa?      -> consistency (chạy 2 lần phải khớp tuyệt đối vì engine
                               deterministic) + sanity (KL > 0, đơn vị hợp lệ).
  2. Bóc được THÉP/sắt chưa? -> engine KHÔNG có rowKey thép (giới hạn đã biết: cần bản
                               kết cấu). Harness chứng minh: thép vắng mặt + checklist.
  3. Nhiều bản vẽ thì sao?    -> chạy per-drawing, đo coverage theo bộ môn (KT/KC/…),
                               cảnh báo đa-cụm (khối lượng là TỔNG, cần bóc theo vùng).

Yêu cầu: pip install requests
Chạy:
  python test_takeoff.py \
      --base-url http://localhost:4000 \
      --email you@example.com --password secret \
      --drawing KT.dwg:KT --drawing KC.dwg:KC \
      --units 0.001 --floor-height 3.3 --wall-thickness 0.2 --beam-depth 0.4 \
      [--ground-truth gt.json]

--drawing PATH[:DISCIPLINE]  (DISCIPLINE ∈ KT/KC/DIEN/NUOC/KHAC; bỏ trống = auto theo tên)
--ground-truth: JSON {"KT.dwg": {"AE.62210": 2150.0, ...}} để so mã→khối lượng (±10%).
"""
from __future__ import annotations
import argparse
import json
import os
import sys
import time
from typing import Any

try:
    import requests
except ImportError:
    sys.exit("Cần: pip install requests")

# rowKey engine bóc được theo bộ môn (khớp DISCIPLINE_ROWKEYS backend).
DISCIPLINE_ROWKEYS = {
    "KT": {"wall_area", "wall_volume", "wall_paint", "door", "window",
           "floor_screed", "floor_finish", "ceiling", "ceiling_paint", "skirting"},
    "KC": {"column_concrete", "column_formwork", "beam_concrete", "beam_formwork", "slab"},
    "DIEN": set(),
    "NUOC": set(),
    "KHAC": None,  # không lọc — giữ tất cả
}
# Nhóm KHÔNG bóc được từ bản kiến trúc (kỳ vọng vắng mặt — không phải lỗi).
KNOWN_GAPS = ["cốt thép", "thép", "đào đất", "móng", "điện", "nước", "pccc",
              "chống thấm", "cầu thang", "lan can", "mái"]


class GenSpecClient:
    def __init__(self, base_url: str, email: str, password: str):
        self.base = base_url.rstrip("/")
        self.s = requests.Session()
        self.token = self._login(email, password)
        self.s.headers["Authorization"] = f"Bearer {self.token}"

    def _login(self, email: str, password: str) -> str:
        r = self.s.post(f"{self.base}/auth/login", json={"email": email, "password": password}, timeout=30)
        if r.status_code != 201 and r.status_code != 200:
            # thử register nếu login fail
            r = self.s.post(f"{self.base}/auth/register",
                            json={"name": "QA Takeoff", "email": email, "password": password}, timeout=30)
        r.raise_for_status()
        return r.json()["accessToken"]

    def create_estimate(self, name: str) -> str:
        r = self.s.post(f"{self.base}/estimates", json={"name": name}, timeout=30)
        r.raise_for_status()
        return r.json()["id"]

    def upload_drawing(self, estimate_id: str, path: str, discipline: str | None) -> str:
        with open(path, "rb") as f:
            data = {"discipline": discipline} if discipline else {}
            r = self.s.post(f"{self.base}/estimates/{estimate_id}/drawings",
                            files={"file": (os.path.basename(path), f)}, data=data, timeout=120)
        r.raise_for_status()
        return r.json()["id"]

    def wait_ready(self, estimate_id: str, drawing_id: str, timeout_s: int = 400) -> dict:
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            r = self.s.get(f"{self.base}/estimates/{estimate_id}/drawings/{drawing_id}", timeout=30)
            r.raise_for_status()
            d = r.json()
            st = d.get("parseStatus")
            if st == "ready":
                return d
            if st == "failed":
                raise RuntimeError(f"parse failed: {d.get('parseError')}")
            time.sleep(3)
        raise TimeoutError(f"drawing {drawing_id} không ready sau {timeout_s}s")

    def run_takeoff(self, estimate_id: str, drawing_id: str, units: float, assumptions: dict) -> dict:
        body = {"drawingId": drawing_id, "unitsPerDrawingUnit": units, "assumptions": assumptions}
        r = self.s.post(f"{self.base}/estimates/{estimate_id}/takeoff-engine", json=body, timeout=300)
        r.raise_for_status()
        return r.json()


def takeoff_rows(resp: dict) -> list[dict]:
    """Lấy 1 dòng/công tác từ actions (nguồn máy-đọc chuẩn)."""
    out = []
    for a in resp.get("actions", []):
        if a.get("type") == "upsert_takeoff":
            out.append({"code": a.get("code", ""), "name": a.get("name", ""),
                        "unit": a.get("unit", ""), "quantity": a.get("quantity", 0),
                        "group": a.get("group", ""), "note": a.get("note", "")})
    return out


def rowkey_of(note: str) -> str | None:
    """Trích [nhóm:x] từ note để đối chiếu coverage."""
    if "[nhóm:" in note:
        return note.split("[nhóm:", 1)[1].split("]", 1)[0].strip()
    return None


def findings_by_severity(resp: dict, sev: str) -> list[dict]:
    return [f for f in resp.get("validation", {}).get("findings", []) if f.get("severity") == sev]


# ---------- Đánh giá ----------
def evaluate(name: str, discipline: str, r1: dict, r2: dict, gt: dict | None) -> dict:
    rows1, rows2 = takeoff_rows(r1), takeoff_rows(r2)
    checks: list[tuple[str, bool, str]] = []

    # 1. CONSISTENCY — engine deterministic: 2 lần chạy phải KHỚP TUYỆT ĐỐI.
    q1 = {row["code"] or row["name"]: row["quantity"] for row in rows1}
    q2 = {row["code"] or row["name"]: row["quantity"] for row in rows2}
    consistent = q1 == q2
    checks.append(("Nhất quán (chạy 2 lần khớp)", consistent,
                   "OK" if consistent else f"LỆCH: {q1} vs {q2}"))

    # 2. SANITY — KL > 0, đơn vị hợp lệ.
    bad = [row for row in rows1 if not (isinstance(row["quantity"], (int, float)) and row["quantity"] > 0)
           or row["unit"] not in ("m", "m2", "m3")]
    checks.append(("KL hợp lệ (>0, đơn vị m/m2/m3)", not bad,
                   "OK" if not bad else f"{len(bad)} dòng bất thường"))

    # 3. COVERAGE theo bộ môn.
    got_keys = {k for k in (rowkey_of(row["note"]) for row in rows1) if k}
    expected = DISCIPLINE_ROWKEYS.get(discipline)
    if expected is None:
        cov_txt = f"{len(got_keys)} nhóm (KHAC: không lọc)"
        cov_ok = len(rows1) > 0
    elif not expected:
        cov_txt = f"bộ môn {discipline}: engine không bóc rowKey (chỉ checklist) — {len(rows1)} dòng"
        cov_ok = True  # đúng thiết kế
    else:
        hit = got_keys & expected
        cov_txt = f"{len(hit)}/{len(expected)} nhóm kỳ vọng: {sorted(hit)}"
        cov_ok = len(hit) > 0
    checks.append((f"Coverage bộ môn {discipline}", cov_ok, cov_txt))

    # 4. GAP thép/MEP — kỳ vọng VẮNG (không phải lỗi). Chứng minh cho user.
    gap_hits = [row for row in rows1 if any(g in row["name"].lower() for g in ("cốt thép", "thép", "điện", "nước", "pccc"))]
    checks.append(("Thép/MEP KHÔNG bị bịa số", not gap_hits,
                   "đúng: không có (cần bản KC/MEP)" if not gap_hits else f"BẤT THƯỜNG có {len(gap_hits)} dòng"))
    has_checklist = any(g in r1.get("message", "").lower() for g in ("cốt thép", "cần bản k"))
    checks.append(("Có checklist 'cần bổ sung' (minh bạch)", has_checklist,
                   "OK" if has_checklist else "thiếu nhắc phần chưa bóc"))

    # 5. Cảnh báo đa-cụm (khối lượng là TỔNG).
    multi = [f for f in findings_by_severity(r1, "error") if "multi-drawing" in f.get("id", "")]
    override = [f for f in r1.get("validation", {}).get("findings", []) if "factor-override" in f.get("id", "")]

    # 6. Ground-truth (nếu có) — so mã→KL ±10%.
    gt_txt = ""
    if gt:
        diffs = []
        for code, exp in gt.items():
            act = q1.get(code)
            if act is None:
                diffs.append(f"{code}: THIẾU")
            elif exp and abs(act - exp) / exp > 0.10:
                diffs.append(f"{code}: {act} vs {exp} (lệch {round((act-exp)/exp*100)}%)")
        ok = not diffs
        checks.append(("So ground-truth (±10%)", ok, "OK" if ok else "; ".join(diffs)))

    return {"name": name, "discipline": discipline, "rows": len(rows1), "checks": checks,
            "multi_cluster": bool(multi), "factor_override": bool(override),
            "groups": sorted({row["group"] for row in rows1 if row["group"]})}


def print_report(results: list[dict]) -> bool:
    print("\n" + "=" * 72)
    print("BÁO CÁO ĐÁNH GIÁ BÓC TÁCH — deterministic takeoff engine")
    print("=" * 72)
    all_ok = True
    for res in results:
        print(f"\n▶ {res['name']}  [bộ môn {res['discipline']}]  — {res['rows']} dòng công tác")
        print(f"  Nhóm BOQ: {', '.join(res['groups']) or '—'}")
        if res["multi_cluster"]:
            print("  ⚠ ĐA-CỤM: khối lượng là TỔNG nhiều mặt bằng → cần bóc theo vùng (không nộp được số này).")
        if res["factor_override"]:
            print("  ⚠ Tỉ lệ tự chỉnh (unitsPerDrawingUnit gửi lên không hợp lý).")
        for label, ok, detail in res["checks"]:
            mark = "✅" if ok else "❌"
            if not ok:
                all_ok = False
            print(f"  {mark} {label}: {detail}")
    print("\n" + "-" * 72)
    print("KẾT LUẬN THÉP/MEP: engine chỉ bóc KT (tường/cửa/hoàn thiện) + KC (BT/ván khuôn/sàn).")
    print("  Thép, móng, điện, nước, chống thấm, cầu thang, mái = CHỈ checklist, KHÔNG ra số")
    print("  (cần bản kết cấu/MEP + nhận diện chuyên sâu). Đây là giới hạn ĐÃ BIẾT, không phải bug.")
    print("=" * 72)
    print(("✅ TỔNG: bóc tách ỔN (nhất quán + hợp lệ)" if all_ok
           else "❌ TỔNG: có kiểm tra KHÔNG đạt — xem chi tiết trên"))
    return all_ok


def main():
    ap = argparse.ArgumentParser(description="Đánh giá AI bóc tách GenSpec qua nhiều bản vẽ")
    ap.add_argument("--base-url", default=os.getenv("GENSPEC_API", "http://localhost:4000"))
    ap.add_argument("--email", default=os.getenv("GENSPEC_EMAIL", "realtimeroboticsvn@gmail.com"))
    ap.add_argument("--password", default=os.getenv("GENSPEC_PASSWORD", ""))
    ap.add_argument("--drawing", action="append", default=[], metavar="PATH[:DISC]",
                    help="đường dẫn bản vẽ, tuỳ chọn :KT/:KC/… (lặp lại cho nhiều bản)")
    ap.add_argument("--units", type=float, default=0.001)
    ap.add_argument("--floor-height", type=float, default=3.3)
    ap.add_argument("--wall-thickness", type=float, default=0.2)
    ap.add_argument("--beam-depth", type=float, default=0.4)
    ap.add_argument("--ground-truth", default=None)
    args = ap.parse_args()

    if not args.drawing:
        sys.exit("Cần ít nhất 1 --drawing PATH[:DISC]")
    if not args.password:
        sys.exit("Cần --password (hoặc env GENSPEC_PASSWORD)")

    gt_all = json.load(open(args.ground_truth, encoding="utf-8")) if args.ground_truth else {}
    assumptions = {"floorHeight": args.floor_height, "wallThickness": args.wall_thickness, "beamDepth": args.beam_depth}

    client = GenSpecClient(args.base_url, args.email, args.password)
    est_id = client.create_estimate(f"[QA] Takeoff {int(time.time())}")
    print(f"Estimate: {est_id}")

    results = []
    for spec in args.drawing:
        path, _, disc = spec.partition(":")
        disc = disc.upper() or None
        base = os.path.basename(path)
        print(f"\n— Upload {base} (bộ môn {disc or 'auto'})…")
        try:
            did = client.upload_drawing(est_id, path, disc)
            d = client.wait_ready(est_id, did)
            actual_disc = d.get("discipline", disc or "KHAC")
            r1 = client.run_takeoff(est_id, did, args.units, assumptions)
            r2 = client.run_takeoff(est_id, did, args.units, assumptions)  # lần 2 kiểm nhất quán
            results.append(evaluate(base, actual_disc, r1, r2, gt_all.get(base)))
        except Exception as e:  # noqa: BLE001
            print(f"  ❌ Lỗi: {e}")
            results.append({"name": base, "discipline": disc or "?", "rows": 0,
                            "checks": [("Chạy được", False, str(e))],
                            "multi_cluster": False, "factor_override": False, "groups": []})

    ok = print_report(results)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
