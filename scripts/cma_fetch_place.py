#!/usr/bin/env python3
"""
CMA 国家库 - 抓取指定场所资质明细

用法:
    # 先查看有哪些场所
    python scripts/cma_fetch_place.py --cert 230020349767 --list-places

    # 抓取指定场所的全部资质
    python scripts/cma_fetch_place.py --cert 230020349767 --place-id 460F37751EF83663E0639602A8C0EA21

    # 抓取并保存到本地数据库
    python scripts/cma_fetch_place.py --cert 230020349767 --place-id 460F37751EF83663E0639602A8C0EA21 --save
"""

import argparse
import base64
import json
import re
import sqlite3
import sys
import time
from datetime import datetime
from html import unescape
from urllib.parse import quote

import cv2
import numpy as np
import requests


# ─── 配置 ──────────────────────────────────────────────────────────────

BASE = "https://cma.cnca.cn/cma"
LIST_URL = f"{BASE}/solr/tBzAbilitySearch/list"
ABILITY_URL = f"{BASE}/solr/tBzAbilitySearch/formAbility"
CAPTCHA_URL = f"{BASE}/base/tBaRegistered/getSliderCaptcha"
VERIFY_URL = f"{BASE}/base/tBaRegistered/captchaVerify"

SLIDER_WIDTH = 45
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

DB_PATH = "data/cma_national.db"


# ─── 工具函数 ──────────────────────────────────────────────────────────

def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", value)).replace("\xa0", " ")).strip()


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": UA, "Referer": LIST_URL})
    session.get(LIST_URL, timeout=30)
    return session


def gap_left_x(bg_bytes: bytes, y: int) -> int:
    bg = cv2.imdecode(np.frombuffer(bg_bytes, np.uint8), cv2.IMREAD_COLOR)
    gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    top = max(0, min(y, height - SLIDER_WIDTH))
    band = gray[top:top + SLIDER_WIDTH].astype(np.float32)
    col = np.abs(cv2.Sobel(band, cv2.CV_32F, 1, 0, ksize=3)).sum(axis=0)
    best_score, best_x = -1.0, 0
    for x in range(8, width - SLIDER_WIDTH):
        score = float(col[x] + col[x + SLIDER_WIDTH - 1])
        if score > best_score:
            best_score, best_x = score, x
    return best_x


def pass_slider(session: requests.Session, max_tries: int = 8) -> int | None:
    xhr = {"X-Requested-With": "XMLHttpRequest"}
    for attempt in range(max_tries):
        try:
            payload = session.get(CAPTCHA_URL, headers=xhr, timeout=30).json()
            bg_bytes = base64.b64decode(payload["bg"])
            y = int(payload.get("y", 0))
            move_x = gap_left_x(bg_bytes, y)
            print(f"  [尝试 {attempt + 1}/{max_tries}] x={move_x}", end=" ")
            result = session.post(VERIFY_URL, data={"moveX": str(move_x)}, headers=xhr, timeout=30).text.strip()
            if result == "success":
                print("✓")
                return move_x
            print("✗")
            time.sleep(0.3)
        except Exception as e:
            print(f"错误: {e}")
            time.sleep(0.5)
    return None


# ─── 数据库 ────────────────────────────────────────────────────────────

def init_db():
    """初始化本地数据库"""
    import os
    os.makedirs("data", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cma_places (
            place_id TEXT PRIMARY KEY,
            cert_code TEXT,
            org_name TEXT,
            place_type TEXT,
            place_name TEXT,
            place_address TEXT,
            apply_id TEXT,
            synced_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cma_abilities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            place_id TEXT,
            cert_code TEXT,
            category TEXT,
            type_name TEXT,
            item_name TEXT,
            std_name TEXT,
            std_code TEXT,
            synced_at TEXT,
            FOREIGN KEY (place_id) REFERENCES cma_places(place_id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_abilities_place ON cma_abilities(place_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_abilities_std_code ON cma_abilities(std_code)")
    conn.commit()
    return conn


def save_place(conn: sqlite3.Connection, place: dict):
    """保存场所信息"""
    conn.execute("""
        INSERT OR REPLACE INTO cma_places
        (place_id, cert_code, org_name, place_type, place_name, place_address, apply_id, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        place["placeId"], place.get("certCode", ""),
        place.get("orgName", ""), place.get("placeType", ""),
        place.get("placeName", ""), place.get("placeAddress", ""),
        place.get("applyId", ""), datetime.now().isoformat()
    ))
    conn.commit()


def save_abilities(conn: sqlite3.Connection, place_id: str, cert_code: str, abilities: list):
    """保存资质明细"""
    # 先删除该场所旧数据
    conn.execute("DELETE FROM cma_abilities WHERE place_id = ?", (place_id,))

    now = datetime.now().isoformat()
    for a in abilities:
        conn.execute("""
            INSERT INTO cma_abilities
            (place_id, cert_code, category, type_name, item_name, std_name, std_code, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            place_id, cert_code,
            a.get("大类", ""), a.get("类别", ""),
            a.get("产品/项目/参数", ""), a.get("标准名称", ""),
            a.get("标准编号", ""), now
        ))
    conn.commit()
    print(f"  [数据库] 已保存 {len(abilities)} 条资质到 {DB_PATH}")


# ─── API 调用 ──────────────────────────────────────────────────────────

def list_places(session: requests.Session, cert_code: str) -> list[dict]:
    """获取机构的所有场所"""
    final_x = pass_slider(session)
    if final_x is None:
        raise RuntimeError("滑块验证失败")

    fields = [
        ("pageNo", "1"), ("pageSize", "-1"),
        ("applyId", ""), ("placeId", ""), ("flag", ""),
        ("applyOrgName", ""), ("placeAddressDetail", ""),
        ("applyFieldCode", ""), ("applySectorBoard", ""),
        ("abilityParentName", ""), ("abilityTypeName", ""),
        ("abilityItemName", ""), ("abilityStandardName", ""),
        ("abilityStandardCode", ""),
        ("certCode", quote(cert_code.encode("utf-8"))),
        ("finalX", str(final_x)),
    ]

    body = "&".join(f"{k}={v}" for k, v in fields)
    html = session.post(LIST_URL, data=body, timeout=40,
                       headers={"Content-Type": "application/x-www-form-urlencoded"}).text

    # 提取 placeId/applyId
    m = re.search(r'data-placeid="([^"]+)"\s+data-applyid="([^"]+)"', html)
    if not m:
        return []

    place_id, apply_id = m.group(1), m.group(2)

    # 获取场所列表
    final_x = pass_slider(session)
    if final_x is None:
        raise RuntimeError("场所表滑块失败")

    params = {
        "placeId": place_id, "applyId": apply_id,
        "applyOrgName": "", "abilityParentName": "",
        "abilityTypeName": "", "abilityItemName": "",
        "abilityStandardName": "", "abilityStandardCode": "",
        "placeAddressDetail": "", "flag": "1",
        "finalX": str(final_x),
    }

    html = session.get(ABILITY_URL, params=params, timeout=60).text

    # 解析场所表
    places = []
    tbodies = re.findall(r"<tbody[^>]*>(.*?)</tbody>", html, re.S | re.I)
    if not tbodies:
        return places

    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", tbodies[0], re.S | re.I):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        m = re.search(r'value="([0-9A-Fa-f]{20,})"[^>]*type="hidden"', row)
        if not m:
            m = re.search(r'type="hidden"[^>]*value="([0-9A-Fa-f]{20,})"', row)
        if len(cells) >= 3 and m:
            places.append({
                "placeId": m.group(1),
                "applyId": apply_id,
                "certCode": cert_code,
                "placeType": clean_text(cells[0]),
                "placeName": clean_text(cells[1]),
                "placeAddress": clean_text(cells[2]),
            })

    return places


def fetch_abilities(session: requests.Session, place_id: str, apply_id: str,
                    page_size: int = 50, max_pages: int = 0) -> tuple[list[dict], int | None]:
    """
    抓取单个场所的资质明细。

    限流策略（来自 qual-match 经验）：
    - 4 页一组，每组完成后等待 30 秒
    - 遇到"参数有误"错误，回退到上一页并重试
    - 每页等待 0.5 秒
    """
    rows = []
    page_no, total = 1, None
    BATCH_SIZE = 4  # 每组页数
    BATCH_COOLDOWN = 30  # 每组冷却时间（秒）
    PAGE_DELAY = 0.5  # 每页间隔（秒）

    while True:
        # 滑块验证
        final_x = pass_slider(session)
        if final_x is None:
            print(f"\n[!] 第 {page_no} 页滑块失败，等待 10 秒重试...")
            time.sleep(10)
            continue

        # 构造请求
        data = {
            "pageNo": str(page_no), "pageSize": str(page_size),
            "placeId": place_id, "applyId": apply_id,
            "applyOrgName": "", "abilityParentName": "",
            "abilityTypeName": "", "abilityItemName": "",
            "abilityStandardName": "", "abilityStandardCode": "",
            "placeAddressDetail": "", "flag": "1",
            "finalX": str(final_x),
        }

        # 发送请求
        html = session.post(ABILITY_URL, data=data, timeout=60,
                           headers={"Content-Type": "application/x-www-form-urlencoded"}).text

        # 检查是否触发限流
        if "参数有误" in html or "服务器无法解析" in html:
            print(f"\n[!] 第 {page_no} 页触发限流，等待 60 秒后重试...")
            time.sleep(60)
            # 回退到上一页重试
            if page_no > 1:
                page_no -= 1
            continue

        # 提取总数
        if total is None:
            m = re.search(r"共\s*(\d+)\s*条", html)
            total = int(m.group(1)) if m else None

        # 解析数据
        tbodies = re.findall(r"<tbody[^>]*>(.*?)</tbody>", html, re.S | re.I)
        detail = tbodies[1] if len(tbodies) >= 2 else (tbodies[0] if tbodies else "")

        page_rows = re.findall(r"<tr[^>]*>(.*?)</tr>", detail, re.S | re.I)
        if not page_rows:
            print(f"\n[!] 第 {page_no} 页无数据")
            break

        # 提取资质行
        for row in page_rows:
            cells = [clean_text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)]
            if len(cells) >= 6:
                rows.append({
                    "大类": cells[1] if len(cells) > 1 else "",
                    "类别": cells[2] if len(cells) > 2 else "",
                    "产品/项目/参数": cells[3] if len(cells) > 3 else "",
                    "标准名称": cells[4] if len(cells) > 4 else "",
                    "标准编号": cells[5] if len(cells) > 5 else "",
                })

        print(f"  第 {page_no} 页: {len(rows)}/{total or '?'} 条", end="\r")

        # 检查是否完成
        if total is not None and len(rows) >= total:
            break
        if max_pages and page_no >= max_pages:
            break

        page_no += 1

        # 分组冷却：每 BATCH_SIZE 页后休息
        if (page_no - 1) % BATCH_SIZE == 0:
            print(f"\n  [冷却] 已完成 {(page_no - 1) // BATCH_SIZE} 组，等待 {BATCH_COOLDOWN} 秒...")
            time.sleep(BATCH_COOLDOWN)
        else:
            time.sleep(PAGE_DELAY)

    print()  # 换行
    return rows, total


# ─── CLI ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='CMA 国家库 - 抓取场所资质')
    parser.add_argument('--cert', '-c', required=True, help='证书编号')
    parser.add_argument('--list-places', action='store_true', help='列出所有场所')
    parser.add_argument('--place-id', '-p', help='指定场所 ID')
    parser.add_argument('--save', action='store_true', help='保存到本地数据库')
    parser.add_argument('--output', '-o', help='输出 JSON 文件')
    parser.add_argument('--max-pages', type=int, default=0, help='最多抓几页(0=全量)')

    args = parser.parse_args()

    print("=" * 60)
    print("CMA 国家库 - 场所资质抓取")
    print("=" * 60)

    session = make_session()

    # 列出场所
    if args.list_places:
        print(f"\n[*] 查询证书 {args.cert} 的场所列表...")
        places = list_places(session, args.cert)

        if not places:
            print("[!] 未找到场所")
            return 1

        print(f"\n[+] 找到 {len(places)} 个场所:\n")
        for i, p in enumerate(places, 1):
            print(f"  {i}. [{p['placeType']}] {p['placeName']}")
            print(f"     地址: {p['placeAddress']}")
            print(f"     placeId: {p['placeId']}")
            print()

        # 保存场所信息到数据库
        if args.save:
            conn = init_db()
            for p in places:
                save_place(conn, p)
            conn.close()
            print(f"[+] 场所信息已保存到 {DB_PATH}")

        return 0

    # 抓取指定场所
    if args.place_id:
        print(f"\n[*] 抓取场所 {args.place_id} 的资质...")

        # 先尝试从数据库读取场所信息
        target = None
        try:
            conn = init_db()
            cached = conn.execute(
                "SELECT place_id, cert_code, apply_id, place_type, place_name, place_address FROM cma_places WHERE place_id = ?",
                (args.place_id,)
            ).fetchone()
            conn.close()
            if cached:
                target = {
                    "placeId": cached[0], "certCode": cached[1], "applyId": cached[2],
                    "placeType": cached[3], "placeName": cached[4], "placeAddress": cached[5],
                }
                print(f"[+] 从缓存读取场所信息")
        except:
            pass

        # 如果数据库没有，从网络获取
        if not target:
            places = list_places(session, args.cert)
            target = next((p for p in places if p["placeId"] == args.place_id), None)

        if not target:
            print(f"[!] 未找到场所 {args.place_id}")
            print("[*] 请先运行: python scripts/cma_fetch_place.py --cert {args.cert} --list-places --save")
            return 1

        print(f"[+] 场所: {target['placeName']}")
        print(f"    地址: {target['placeAddress']}")

        abilities, total = fetch_abilities(
            session,
            target["placeId"],
            target["applyId"],
            max_pages=args.max_pages
        )

        print(f"\n[+] 完成! 获取 {len(abilities)}/{total or '?'} 条资质")

        # 保存到数据库
        if args.save:
            conn = init_db()
            save_place(conn, target)
            save_abilities(conn, target["placeId"], args.cert, abilities)
            conn.close()

        # 输出 JSON
        if args.output:
            output = {
                "place": target,
                "abilities": abilities,
                "total": len(abilities),
                "synced_at": datetime.now().isoformat()
            }
            with open(args.output, 'w', encoding='utf-8') as f:
                json.dump(output, f, ensure_ascii=False, indent=2)
            print(f"[+] 结果已保存到 {args.output}")

        return 0

    print("[!] 请指定 --list-places 或 --place-id")
    return 1


if __name__ == '__main__':
    sys.exit(main())