#!/usr/bin/env python3
"""
CMA 资质认定获证机构能力查询 - 自动化搜索脚本

基于 qual-match 项目的滑块验证码实现，使用纯 API 方式。

用法:
    python scripts/cma_search.py --cert 230020349767
    python scripts/cma_search.py --cert 230020349767 --output results.json
"""

import argparse
import base64
import json
import re
import sys
import time
from html import unescape
from urllib.parse import quote

import cv2
import numpy as np
import requests


# ─── 配置 ──────────────────────────────────────────────────────────────

BASE = "https://cma.cnca.cn/cma"
LIST_URL = f"{BASE}/solr/tBzAbilitySearch/list"
CAPTCHA_URL = f"{BASE}/base/tBaRegistered/getSliderCaptcha"
VERIFY_URL = f"{BASE}/base/tBaRegistered/captchaVerify"

SLIDER_WIDTH = 45  # 滑块/缺口宽度
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def clean_text(value: str) -> str:
    """清理 HTML 文本"""
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", value)).replace("\xa0", " ")).strip()


def make_session() -> requests.Session:
    """创建 requests session 并预热"""
    session = requests.Session()
    session.headers.update({"User-Agent": UA, "Referer": LIST_URL})
    session.get(LIST_URL, timeout=30)  # 预热，拿 session cookie
    return session


# ─── 缺口检测（来自 qual-match）────────────────────────────────────────

def gap_left_x(bg_bytes: bytes, y: int) -> int:
    """
    缺口直检：返回缺口左边缘 x（= 前端 moveX）。

    在缺口所在行带 (y .. y+45) 内，对灰度图做垂直 Sobel；
    缺口由相距一个滑块宽(45px)的两条竖直边缘围成，
    col[x]+col[x+44] 取最大处即缺口左缘。
    """
    bg = cv2.imdecode(np.frombuffer(bg_bytes, np.uint8), cv2.IMREAD_COLOR)
    gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape

    # 定位到缺口所在行带
    top = max(0, min(y, height - SLIDER_WIDTH))
    band = gray[top:top + SLIDER_WIDTH].astype(np.float32)

    # 垂直 Sobel 边缘检测
    col = np.abs(cv2.Sobel(band, cv2.CV_32F, 1, 0, ksize=3)).sum(axis=0)

    # 找相距 SLIDER_WIDTH 的两条竖边
    best_score, best_x = -1.0, 0
    for x in range(8, width - SLIDER_WIDTH):  # 从 8 起跳，避开左侧固有竖边
        score = float(col[x] + col[x + SLIDER_WIDTH - 1])
        if score > best_score:
            best_score, best_x = score, x

    return best_x


# ─── 滑块验证 ──────────────────────────────────────────────────────────

def pass_slider(session: requests.Session, max_tries: int = 8) -> int | None:
    """过一次滑块，返回成功的 moveX；失败返回 None。"""
    xhr = {"X-Requested-With": "XMLHttpRequest"}

    for attempt in range(max_tries):
        try:
            # 获取验证码
            payload = session.get(CAPTCHA_URL, headers=xhr, timeout=30).json()
            bg_bytes = base64.b64decode(payload["bg"])
            y = int(payload.get("y", 0))

            # 检测缺口位置
            move_x = gap_left_x(bg_bytes, y)
            print(f"  [尝试 {attempt + 1}/{max_tries}] 检测到缺口 x={move_x}")

            # 提交验证
            result = session.post(
                VERIFY_URL,
                data={"moveX": str(move_x)},
                headers=xhr,
                timeout=30
            ).text.strip()

            if result == "success":
                print(f"  [成功] 验证通过，moveX={move_x}")
                return move_x
            else:
                print(f"  [失败] 服务端返回: {result}")
                time.sleep(0.3)
        except Exception as e:
            print(f"  [错误] {e}")
            time.sleep(0.5)

    return None


# ─── 搜索功能 ──────────────────────────────────────────────────────────

def search_certificate(session: requests.Session, cert_code: str) -> list[dict]:
    """按证书编号搜索能力信息"""
    # 先过滑块
    final_x = pass_slider(session)
    if final_x is None:
        raise RuntimeError("滑块验证失败")

    # 构造表单数据
    fields = [
        ("pageNo", "1"),
        ("pageSize", "-1"),
        ("applyId", ""),
        ("placeId", ""),
        ("flag", ""),
        ("applyOrgName", ""),
        ("placeAddressDetail", ""),
        ("applyFieldCode", ""),
        ("applySectorBoard", ""),
        ("abilityParentName", ""),
        ("abilityTypeName", ""),
        ("abilityItemName", ""),
        ("abilityStandardName", ""),
        ("abilityStandardCode", ""),
        ("certCode", quote(cert_code.encode("utf-8"))),
        ("finalX", str(final_x)),  # 关键：必须带 finalX
    ]

    body = "&".join(f"{k}={v}" for k, v in fields)
    html = session.post(
        LIST_URL,
        data=body,
        timeout=40,
        headers={"Content-Type": "application/x-www-form-urlencoded"}
    ).text

    # 解析结果
    results = []
    tbody = re.search(r"<tbody>(.*?)</tbody>", html, re.S | re.I)
    if not tbody:
        return results

    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", tbody.group(1), re.S | re.I):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        if len(cells) >= 6:
            results.append({
                "序号": clean_text(cells[0]),
                "证书号": clean_text(cells[1]),
                "机构名称": clean_text(cells[2]),
                "场所地址": clean_text(cells[3]),
                "联系人": clean_text(cells[4]),
                "联系方式": clean_text(cells[5]),
            })

    return results


# ─── CLI 入口 ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='CMA 资质认定获证机构能力查询')
    parser.add_argument('--cert', '-c', help='证书编号')
    parser.add_argument('--output', '-o', help='输出 JSON 文件路径')
    parser.add_argument('--pretty', action='store_true', help='格式化 JSON 输出')
    parser.add_argument('--self-test', action='store_true', help='只测试滑块稳定性')

    args = parser.parse_args()

    # 验证参数
    if not args.self_test and not args.cert:
        parser.error("请提供证书编号 (--cert) 或使用自测模式 (--self-test)")

    print("=" * 60)
    print("CMA 资质认定获证机构能力查询")
    print("=" * 60)

    session = make_session()

    # 自测模式：测试滑块稳定性
    if args.self_test:
        print("\n[*] 滑块稳定性测试（20 次）...")
        ok = sum(1 for _ in range(20) if pass_slider(session) is not None)
        print(f"\n[结果] 稳定性: {ok}/20")
        return 0

    # 正常搜索
    print(f"\n[*] 证书编号: {args.cert}")
    print("[*] 开始搜索...\n")

    try:
        results = search_certificate(session, args.cert)

        # 构造输出
        output = {
            "certCode": args.cert,
            "status": "success",
            "data": results,
            "total": len(results)
        }

        # 输出结果
        indent = 2 if args.pretty else None
        json_str = json.dumps(output, ensure_ascii=False, indent=indent)

        if args.output:
            with open(args.output, 'w', encoding='utf-8') as f:
                f.write(json_str)
            print(f"\n[+] 结果已保存到: {args.output}")
        else:
            print(json_str)

        # 打印摘要
        print(f"\n{'=' * 60}")
        print(f"状态: 成功")
        print(f"记录数: {len(results)}")
        for item in results:
            print(f"\n  证书号: {item.get('证书号', 'N/A')}")
            print(f"  机构: {item.get('机构名称', 'N/A')}")
            print(f"  地址: {item.get('场所地址', 'N/A')}")
        print("=" * 60)

        return 0

    except Exception as e:
        print(f"\n[!] 错误: {e}")
        return 1


if __name__ == '__main__':
    sys.exit(main())


# ─── 人类轨迹模拟 ──────────────────────────────────────────────────────

def generate_human_track(distance: int) -> list[dict]:
    """
    生成模拟人类滑动的轨迹。

    特点：
    1. 先快后慢（加速-匀速-减速）
    2. 有微小的上下抖动
    3. 末尾有轻微过冲和回弹
    """
    track = []
    current = 0

    # 加速阶段
    accel_dist = distance * 0.7
    # 减速阶段
    decel_dist = distance * 0.3

    t = 0.3  # 初始时间间隔
    v = 0  # 初始速度

    while current < distance:
        if current < accel_dist:
            # 加速
            a = random.uniform(2, 4)
        elif current < distance - 10:
            # 匀速/减速
            a = random.uniform(-1, -3)
        else:
            # 末尾微调
            a = random.uniform(-0.5, 0.5)

        v = max(1, v + a)
        move = min(v, distance - current)
        current += move

        # 添加 Y 轴微小抖动
        y_offset = random.uniform(-2, 2)

        track.append({
            'x': round(current),
            'y': round(y_offset),
            'duration': round(t + random.uniform(0.01, 0.05), 3)
        })

        t = random.uniform(0.01, 0.03)

    # 末尾过冲和回弹
    overshoot = random.randint(2, 5)
    track.append({
        'x': distance + overshoot,
        'y': 0,
        'duration': 0.05
    })
    track.append({
        'x': distance,
        'y': 0,
        'duration': 0.08
    })

    return track


# ─── 主流程 ────────────────────────────────────────────────────────────

def solve_captcha(page: Page) -> bool:
    """
    解决滑块验证码。

    返回 True 表示验证成功。
    """
    print("[*] 等待验证码加载...")
    time.sleep(1)

    # 获取验证码图片
    bg_element = page.query_selector('.img-canvas')
    slider_element = page.query_selector('.slider-block')

    if not bg_element or not slider_element:
        print("[!] 未找到验证码元素")
        return False

    # 从页面获取 base64 图片
    bg_style = bg_element.evaluate('el => getComputedStyle(el).backgroundImage')
    slider_src = slider_element.get_attribute('src')

    if not bg_style or not slider_src:
        print("[!] 无法获取验证码图片")
        return False

    # 提取 base64 数据
    bg_base64 = bg_style.split('base64,')[1].rstrip('")')
    slider_base64 = slider_src.split('base64,')[1]

    print("[*] 检测缺口位置...")

    # 保存验证码图片用于调试
    bg_data = base64.b64decode(bg_base64)
    with open("captcha_bg.png", "wb") as f:
        f.write(bg_data)
    print("[*] 背景图已保存: captcha_bg.png")

    if slider_base64:
        slider_data = base64.b64decode(slider_base64)
        with open("captcha_slider.png", "wb") as f:
            f.write(slider_data)
        print("[*] 滑块图已保存: captcha_slider.png")

    gap_x = detect_gap_position(bg_base64, slider_base64)
    print(f"[*] 检测到缺口位置: x={gap_x}")

    # 计算需要滑动的距离
    # 滑块块需要对准缺口中心
    slide_distance = max(0, min(gap_x, SLIDER_MAX_X))
    print(f"[*] 计算滑动距离: {slide_distance}px")

    # 生成人类轨迹
    track = generate_human_track(slide_distance)

    # 模拟滑动
    print("[*] 执行滑动...")
    handle = page.query_selector('.slider-handle')
    if not handle:
        print("[!] 未找到滑块手柄")
        return False

    # 获取滑块手柄的位置
    handle_box = handle.bounding_box()
    if not handle_box:
        print("[!] 无法获取滑块位置")
        return False

    # 起始位置（滑块中心）
    start_x = handle_box['x'] + handle_box['width'] / 2
    start_y = handle_box['y'] + handle_box['height'] / 2

    # 鼠标移动到滑块中心并按下
    page.mouse.move(start_x, start_y)
    time.sleep(0.1)
    page.mouse.down()
    time.sleep(0.1)

    # 按轨迹滑动（相对于起始位置）
    current_x = start_x
    for point in track:
        target_x = start_x + point['x']
        target_y = start_y + point['y']
        page.mouse.move(target_x, target_y, steps=1)
        time.sleep(point['duration'])
        current_x = target_x

    # 鼠标释放
    page.mouse.up()

    # 等待验证码验证结果
    # 验证码验证通过后会自动提交表单，导致页面跳转
    try:
        # 等待导航（表单提交会导致页面跳转）
        page.wait_for_load_state('networkidle', timeout=5000)
    except:
        # 如果没有导航，可能是验证失败或页面刷新
        pass

    time.sleep(1)

    # 检查是否验证成功（页面应该已经跳转或刷新）
    # 如果还在原页面且验证码还在，说明验证失败
    captcha_box = page.query_selector('#captcha-box')
    if captcha_box and captcha_box.is_visible():
        print("[!] 验证码仍然可见，可能验证失败")
        return False

    return True


def search_certificate(cert_code: str, headless: bool = False, debug: bool = False) -> dict:
    """
    搜索指定证书编号的能力信息。

    Args:
        cert_code: 证书编号
        headless: 是否无头模式

    Returns:
        搜索结果字典
    """
    result = {
        "certCode": cert_code,
        "status": "pending",
        "data": [],
        "error": None
    }

    with sync_playwright() as p:
        # 启动浏览器
        browser = p.chromium.launch(
            headless=headless,
            args=['--disable-blink-features=AutomationControlled']
        )
        context = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 800}
        )
        page = context.new_page()

        try:
            print(f"[*] 打开 CMA 查询页面...")
            page.goto(CMA_URL, wait_until='networkidle', timeout=30000)
            time.sleep(1)

            # 填写证书编号
            print(f"[*] 输入证书编号: {cert_code}")
            cert_input = page.query_selector('input[name="certCode"]')
            if cert_input:
                cert_input.fill(cert_code)
            else:
                raise Exception("未找到证书编号输入框")

            # 点击查询按钮（触发验证码）
            print("[*] 点击查询按钮...")
            submit_btn = page.query_selector('#btnSubmit')
            if submit_btn:
                submit_btn.click()
            else:
                raise Exception("未找到查询按钮")

            time.sleep(1)

            # 解决验证码
            print("[*] 开始解决验证码...")
            max_attempts = 3
            for attempt in range(max_attempts):
                print(f"[*] 尝试第 {attempt + 1}/{max_attempts} 次...")
                if solve_captcha(page):
                    print("[+] 验证码解决成功！")
                    break
                else:
                    print(f"[-] 第 {attempt + 1} 次失败，等待重试...")
                    time.sleep(2)
            else:
                result["status"] = "failed"
                result["error"] = "验证码解决失败（超过最大尝试次数）"
                return result

            # 等待结果加载（等待页面跳转或表格更新）
            print("[*] 等待搜索结果...")
            try:
                # 等待表格出现或页面跳转
                page.wait_for_selector('#contentTable tbody tr', timeout=10000)
            except:
                # 如果表格没有新行，可能已经跳转到详情页
                pass

            time.sleep(2)

            # 检查当前页面 URL
            current_url = page.url
            print(f"[*] 当前页面: {current_url}")

            # 调试模式：保存截图
            if debug:
                page.screenshot(path=f"cma_debug_{cert_code}.png")
                print(f"[*] 调试截图已保存: cma_debug_{cert_code}.png")

            # 解析结果表格
            print("[*] 解析搜索结果...")
            rows = page.query_selector_all('#contentTable tbody tr')

            if rows:
                for row in rows:
                    cells = row.query_selector_all('td')
                    if len(cells) >= 6:
                        item = {
                            "序号": cells[0].inner_text().strip(),
                            "证书号": cells[1].inner_text().strip(),
                            "机构名称": cells[2].inner_text().strip(),
                            "场所地址": cells[3].inner_text().strip(),
                            "联系人": cells[4].inner_text().strip(),
                            "联系方式": cells[5].inner_text().strip(),
                        }
                        result["data"].append(item)
                result["status"] = "success"
                print(f"[+] 找到 {len(result['data'])} 条记录")
            else:
                # 检查是否显示"共 0 条"或页面内容
                page_text = page.inner_text('body')
                if '共 0 条' in page_text:
                    result["status"] = "success"
                    result["data"] = []
                    print("[*] 未找到匹配记录")
                elif '共' in page_text and '条' in page_text:
                    # 可能有结果但解析失败
                    result["status"] = "partial"
                    result["error"] = "结果解析可能不完整"
                    # 保存页面内容用于调试
                    result["debug_page_text"] = page_text[:2000]
                else:
                    result["status"] = "partial"
                    result["error"] = "页面状态未知"
                    result["debug_page_text"] = page_text[:2000]

        except Exception as e:
            result["status"] = "error"
            result["error"] = str(e)
            print(f"[!] 错误: {e}")

        finally:
            browser.close()

    return result


# ─── CLI 入口 ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='CMA 资质认定获证机构能力查询')
    parser.add_argument('--cert', '-c', required=True, help='证书编号')
    parser.add_argument('--output', '-o', help='输出 JSON 文件路径')
    parser.add_argument('--headless', action='store_true', help='无头模式（不显示浏览器）')
    parser.add_argument('--pretty', action='store_true', help='格式化 JSON 输出')
    parser.add_argument('--debug', action='store_true', help='调试模式（保存截图）')

    args = parser.parse_args()

    print(f"=" * 60)
    print(f"CMA 资质认定获证机构能力查询")
    print(f"证书编号: {args.cert}")
    print(f"=" * 60)

    result = search_certificate(args.cert, headless=args.headless, debug=args.debug)

    # 输出结果
    indent = 2 if args.pretty else None
    json_str = json.dumps(result, ensure_ascii=False, indent=indent)

    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(json_str)
        print(f"\n[+] 结果已保存到: {args.output}")
    else:
        print(f"\n{'=' * 60}")
        print("查询结果:")
        print('=' * 60)
        print(json_str)

    # 打印摘要
    print(f"\n{'=' * 60}")
    print(f"状态: {result['status']}")
    if result['data']:
        print(f"记录数: {len(result['data'])}")
        for item in result['data']:
            print(f"\n  证书号: {item.get('证书号', 'N/A')}")
            print(f"  机构: {item.get('机构名称', 'N/A')}")
            print(f"  地址: {item.get('场所地址', 'N/A')}")
    elif result['error']:
        print(f"错误: {result['error']}")
    print('=' * 60)

    return 0 if result['status'] == 'success' else 1


if __name__ == '__main__':
    sys.exit(main())
