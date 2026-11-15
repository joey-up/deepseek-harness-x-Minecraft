"""desktop-eye 的 Windows 屏幕/输入助手。

由 DSH Host 插件以子进程方式调用：stdin 读一个 JSON 请求，stdout 输出一个 JSON 结果。
只做三件事：列窗口、截屏、发 Windows 输入事件（SendInput）。不联网、不读用户文件、
不改系统设置。

请求：
  {"cmd": "windows"}
  {"cmd": "see",  "target": "desktop|focused|game|<hwnd|title|class>", ...}
  {"cmd": "act",  "target": ..., "actions": [...], ...}

输出：单行 JSON（UTF-8，写到 stdout 之前先移除 BOM 风险；Py3 默认 stdout 编码取本地代码页，
所以这里统一把输出写成 ASCII 安全的 JSON）。
"""

import ctypes
import ctypes.wintypes as wt
import json
import os
import sys
import time

from PIL import ImageGrab

# ---------------------------------------------------------------- Win32 基础

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", ctypes.c_ulong),
        ("wParamL", ctypes.c_ushort),
        ("wParamH", ctypes.c_ushort),
    ]


class INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    _fields_ = [("type", ctypes.c_ulong), ("u", _U)]


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_SCANCODE = 0x0008
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_EXTENDEDKEY = 0x0001
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000
SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

VK_NAMES = {
    "ESC": 0x1B, "ESCAPE": 0x1B, "SPACE": 0x20, "TAB": 0x09, "ENTER": 0x0D,
    "SHIFT": 0x10, "LSHIFT": 0xA0, "RSHIFT": 0xA1, "CTRL": 0x11, "LCTRL": 0xA2,
    "RCTRL": 0xA3, "ALT": 0x12, "LALT": 0xA4, "RALT": 0xA5,
    "F1": 0x70, "F2": 0x71, "F3": 0x72, "F4": 0x73, "F5": 0x74, "F6": 0x75,
    "F7": 0x76, "F8": 0x77, "F9": 0x78, "F10": 0x79, "F11": 0x7A, "F12": 0x7B,
    "UP": 0x26, "DOWN": 0x28, "LEFT": 0x25, "RIGHT": 0x27,
    "BACKSPACE": 0x08, "DEL": 0x2E, "DELETE": 0x2E, "INSERT": 0x2D,
    "HOME": 0x24, "END": 0x23, "PGUP": 0x21, "PGDN": 0x22,
}
for _c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
    VK_NAMES[_c] = ord(_c)
for _d in "0123456789":
    VK_NAMES[_d] = ord(_d)


def set_dpi_aware():
    """必须在任何坐标读取之前调用，否则截屏与输入坐标都落在缩放后的逻辑像素上。"""
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
        return True
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
        return True
    except Exception:
        return False


def virtual_screen():
    return (
        user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
    )


def cursor_pos():
    p = POINT()
    user32.GetCursorPos(ctypes.byref(p))
    return {"x": p.x, "y": p.y}


def client_rect_screen(hwnd):
    r = RECT()
    user32.GetClientRect(hwnd, ctypes.byref(r))
    pt = POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    return pt.x, pt.y, r.right - r.left, r.bottom - r.top


def window_rect_screen(hwnd):
    r = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def window_title(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(max(1, n + 1))
    user32.GetWindowTextW(hwnd, buf, max(1, n + 1))
    return buf.value


def window_class(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def window_pid(hwnd):
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def foreground_hwnd():
    return user32.GetForegroundWindow()


def list_windows(include_invisible=False):
    found = []

    def cb(hwnd, _):
        try:
            if not include_invisible and not user32.IsWindowVisible(hwnd):
                return True
            title = window_title(hwnd)
            cls = window_class(hwnd)
            x, y, w, h = window_rect_screen(hwnd)
            if w < 40 or h < 40:
                return True
            found.append(
                {
                    "hwnd": int(hwnd),
                    "title": title,
                    "class": cls,
                    "pid": window_pid(hwnd),
                    "x": x,
                    "y": y,
                    "width": w,
                    "height": h,
                    "client": dict(zip(("x", "y", "width", "height"), client_rect_screen(hwnd))),
                    "minimized": bool(user32.IsIconic(hwnd)),
                    "foreground": int(hwnd) == int(foreground_hwnd()),
                }
            )
        except Exception:
            pass
        return True

    user32.EnumWindows(EnumProc(cb), 0)
    found.sort(key=lambda w: (not w["foreground"], not w["title"], w["title"].lower()))
    return found


def is_game_window(w):
    """只认 GLFW/LWJGL 窗口，避免把标题里带 minecraft 的资源管理器等误判成游戏。"""
    cls = (w.get("class") or "").lower()
    return cls in ("glfw30", "glfw28", "glfw32", "lwjgl")


def resolve_window(target):
    """target: desktop | focused | game | hwnd:<n> | title:<substr> | class:<name> | <raw string>"""
    if not target or target == "desktop":
        return None, "desktop"
    wins = list_windows()
    t = str(target).strip()
    low = t.lower()
    if low in ("focused", "foreground"):
        h = foreground_hwnd()
        for w in wins:
            if w["hwnd"] == int(h):
                return w, "focused"
        return {"hwnd": int(h), "title": window_title(h), "class": window_class(h),
                "x": 0, "y": 0, "width": 0, "height": 0,
                "client": {"x": 0, "y": 0, "width": 0, "height": 0}}, "focused"
    if low in ("game", "minecraft", "mc"):
        for w in wins:
            if is_game_window(w):
                return w, "game"
        return None, "game-missing"
    if low.startswith("hwnd:"):
        h = int(low.split(":", 1)[1], 0)
        for w in wins:
            if w["hwnd"] == h:
                return w, "hwnd"
        return {"hwnd": h, "title": "", "class": "", "x": 0, "y": 0,
                "width": 0, "height": 0,
                "client": {"x": 0, "y": 0, "width": 0, "height": 0}}, "hwnd"
    if low.startswith("class:"):
        sub = low.split(":", 1)[1]
        for w in wins:
            if sub in (w["class"] or "").lower():
                return w, "class"
        return None, "class-missing"
    sub = low[6:] if low.startswith("title:") else low
    for w in wins:
        if sub in (w["title"] or "").lower():
            return w, "title"
    return None, "title-missing"


# ---------------------------------------------------------------- 输入


def _send(inp):
    n = user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
    return n == 1


def key_vk(name):
    if isinstance(name, int):
        return name
    raw = str(name).strip().upper()
    if raw.startswith("VK:") or raw.startswith("0X"):
        try:
            return int(raw.split(":", 1)[1] if ":" in raw else raw, 0)
        except Exception:
            return None
    if raw in VK_NAMES:
        return VK_NAMES[raw]
    if len(raw) == 1:
        code = ord(raw)
        if 32 <= code <= 126:
            return code
    return None


def key_event(vk, down, unicode_char=None):
    inp = INPUT(type=INPUT_KEYBOARD)
    if unicode_char is not None:
        inp.u.ki = KEYBDINPUT(0, ord(unicode_char), KEYEVENTF_UNICODE | (0 if down else KEYEVENTF_KEYUP), 0, 0)
    else:
        scan = user32.MapVirtualKeyW(vk, 0) or vk
        flags = KEYEVENTF_SCANCODE | (0 if down else KEYEVENTF_KEYUP)
        inp.u.ki = KEYBDINPUT(0, scan, flags, 0, 0)
    return _send(inp)


def key_press(name, hold_ms=40):
    vk = key_vk(name)
    if vk is None:
        raise ValueError("unknown key: %s" % (name,))
    key_event(vk, True)
    time.sleep(max(10, int(hold_ms)) / 1000.0)
    key_event(vk, False)
    return "key %s" % name


def key_down(name):
    vk = key_vk(name)
    if vk is None:
        raise ValueError("unknown key: %s" % (name,))
    key_event(vk, True)
    return "keydown %s" % name


def key_up(name):
    vk = key_vk(name)
    if vk is None:
        raise ValueError("unknown key: %s" % (name,))
    key_event(vk, False)
    return "keyup %s" % name


def type_text(text):
    for ch in str(text):
        key_event(0, True, ch)
        key_event(0, False, ch)
        time.sleep(0.012)
    return "typed %d chars" % len(str(text))


def _ease_in_out(t):
    """三次 ease-in-out：起步慢、中间快、收尾慢，像人甩鼠标。"""
    if t <= 0.0:
        return 0.0
    if t >= 1.0:
        return 1.0
    return 4.0 * t * t * t if t < 0.5 else 1.0 - pow(-2.0 * t + 2.0, 3) / 2.0


def _bezier(t, p0, p1, p2, p3):
    u = 1.0 - t
    return u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3


def _send_abs_point(x, y):
    vx, vy, vw, vh = virtual_screen()
    inp = INPUT(type=INPUT_MOUSE)
    inp.u.mi = MOUSEINPUT(
        int(round((x - vx) * 65535.0 / max(1, vw - 1))),
        int(round((y - vy) * 65535.0 / max(1, vh - 1))),
        0,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
        0,
        0,
    )
    return _send(inp)


def mouse_move_abs(x, y, duration_ms=None, curve_px=None):
    """把光标“滑”到 (x,y)，而不是瞬移。

    轨迹是一条二次贝塞尔弧（控制点垂直偏移），进度用 ease-in-out，
    整体看起来就是一次真人甩鼠标：先慢、中间快、最后收住。
    duration_ms 省略时按距离自适应（约 240ms + 0.45ms/像素，夹在 300–900ms）。
    duration_ms=0 时退回瞬移。
    """
    sx, sy = cursor_pos()["x"], cursor_pos()["y"]
    tx, ty = int(x), int(y)
    dx, dy = tx - sx, ty - sy
    dist = (dx * dx + dy * dy) ** 0.5
    if duration_ms is None:
        duration_ms = int(max(300.0, min(900.0, 240.0 + dist * 0.45)))
    duration_ms = int(duration_ms)
    if duration_ms <= 0 or dist < 1.5:
        _send_abs_point(tx, ty)
        return "moveabs(%s,%s) instant" % (tx, ty)
    # 弧高：距离越大弯得越明显，但夹住上限，免得飞到屏幕外太夸张
    if curve_px is None:
        curve_px = max(-120.0, min(120.0, dist * 0.06))
    # 垂直于位移方向的单位向量
    if dist > 0:
        nx, ny = -dy / dist, dx / dist
    else:
        nx, ny = 0.0, 0.0
    cx = (sx + tx) / 2.0 + nx * curve_px
    cy = (sy + ty) / 2.0 + ny * curve_px
    # 60Hz 起步，最长 90 帧
    steps = max(6, min(90, int(round(duration_ms / 16.0))))
    gap = max(0.001, duration_ms / 1000.0 / steps)
    last_x, last_y = sx, sy
    for i in range(1, steps + 1):
        t = _ease_in_out(i / float(steps))
        px = _bezier(t, sx, cx, cx, tx)
        py = _bezier(t, sy, cy, cy, ty)
        ipx, ipy = int(round(px)), int(round(py))
        if (ipx, ipy) != (last_x, last_y):
            _send_abs_point(ipx, ipy)
            last_x, last_y = ipx, ipy
        time.sleep(gap)
    if (last_x, last_y) != (tx, ty):
        _send_abs_point(tx, ty)
    return "moveabs(%s,%s) over %sms curve=%.0fpx dist=%.0fpx" % (tx, ty, duration_ms, curve_px, dist)


def mouse_move_by(dx, dy, duration_ms=None, curve_px=None):
    """相对移动光标：先读当前坐标，再滑到 (x+dx, y+dy)。"""
    start = cursor_pos()
    return mouse_move_abs(start["x"] + int(dx), start["y"] + int(dy), duration_ms, curve_px)


def mouse_move_rel(dx, dy, steps=1, gap_ms=8):
    steps = max(1, min(240, int(steps)))
    step_x = dx / float(steps)
    step_y = dy / float(steps)
    for _ in range(steps):
        inp = INPUT(type=INPUT_MOUSE)
        inp.u.mi = MOUSEINPUT(int(round(step_x)), int(round(step_y)), 0, MOUSEEVENTF_MOVE, 0, 0)
        _send(inp)
        time.sleep(max(0, int(gap_ms)) / 1000.0)
    return "move(%s,%s)x%s" % (dx, dy, steps)


def mouse_move_smooth(dx, dy, duration_ms=800, steps=0, ease=True):
    """把一次视角转动摊成很多小步，避免“瞬移+卡顿”的鬼畜感。

    进度按 ease-in-out 分布，转视角时会“先慢-加速-收尾”，更像人拖鼠标。
    总时长由 duration_ms 控制，steps=0 时按约 8ms 一步自动计算。
    """
    duration_ms = max(30, int(duration_ms))
    if steps <= 0:
        steps = max(8, min(400, int(round(duration_ms / 8.0))))
    steps = max(1, min(1000, int(steps)))
    gap = max(0.001, duration_ms / 1000.0 / steps)
    acc_x = 0.0
    acc_y = 0.0
    sent = 0
    target_x = float(dx)
    target_y = float(dy)
    for i in range(1, steps + 1):
        progress = _ease_in_out(i / float(steps)) if ease else i / float(steps)
        want_x = target_x * progress
        want_y = target_y * progress
        step_x = want_x - acc_x
        step_y = want_y - acc_y
        ix = int(round(step_x))
        iy = int(round(step_y))
        if ix or iy:
            inp = INPUT(type=INPUT_MOUSE)
            inp.u.mi = MOUSEINPUT(ix, iy, 0, MOUSEEVENTF_MOVE, 0, 0)
            if _send(inp):
                sent += 1
            acc_x += ix
            acc_y += iy
        time.sleep(gap)
        if (i + 1) % 40 == 0:
            time.sleep(0.001)
    # 补上取整残留，保证总位移准确
    rest_x = int(round(target_x - acc_x))
    rest_y = int(round(target_y - acc_y))
    if rest_x or rest_y:
        inp = INPUT(type=INPUT_MOUSE)
        inp.u.mi = MOUSEINPUT(rest_x, rest_y, 0, MOUSEEVENTF_MOVE, 0, 0)
        if _send(inp):
            sent += 1
    return "look(%s,%s) over %sms in %s steps ease=%s (%s sent)" % (dx, dy, duration_ms, steps, ease, sent)


def mouse_button(btn, down):
    btn = (btn or "left").lower()
    flag = {
        "left": MOUSEEVENTF_LEFTDOWN if down else MOUSEEVENTF_LEFTUP,
        "right": MOUSEEVENTF_RIGHTDOWN if down else MOUSEEVENTF_RIGHTUP,
        "middle": MOUSEEVENTF_MIDDLEDOWN if down else MOUSEEVENTF_MIDDLEUP,
    }.get(btn)
    if flag is None:
        raise ValueError("unknown mouse button: %s" % (btn,))
    inp = INPUT(type=INPUT_MOUSE)
    inp.u.mi = MOUSEINPUT(0, 0, 0, flag, 0, 0)
    _send(inp)
    return "%s %s" % (btn, "down" if down else "up")


def mouse_wheel(amount):
    inp = INPUT(type=INPUT_MOUSE)
    inp.u.mi = MOUSEINPUT(0, 0, int(amount) & 0xFFFFFFFF, MOUSEEVENTF_WHEEL, 0, 0)
    _send(inp)
    return "wheel %s" % amount


def focus_window(hwnd):
    if not hwnd:
        return False
    try:
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.BringWindowToTop(hwnd)
        hwnd_fg = foreground_hwnd()
        fg_thread = user32.GetWindowThreadProcessId(hwnd_fg, None)
        my_thread = user32.GetCurrentThreadId()
        user32.AttachThreadInput(my_thread, fg_thread, True)
        # 先按一下 Alt，绕过前台锁（Windows 对 SetForegroundWindow 的限制）
        key_event(0x12, True)
        key_event(0x12, False)
        user32.SetForegroundWindow(hwnd)
        user32.AttachThreadInput(my_thread, fg_thread, False)
    except Exception:
        pass
    time.sleep(0.12)
    return int(foreground_hwnd()) == int(hwnd)


# ---------------------------------------------------------------- 截屏


def grab_region(x, y, w, h):
    if w <= 0 or h <= 0:
        raise ValueError("bad capture region %sx%s" % (w, h))
    img = ImageGrab.grab(bbox=(x, y, x + w, y + h), all_screens=True)
    return img


def save_image(img, path, scale=100, max_width=0):
    if max_width and img.width > int(max_width):
        scale = min(scale, int(max_width) * 100.0 / img.width)
    if scale < 100:
        nw = max(1, int(round(img.width * scale / 100.0)))
        nh = max(1, int(round(img.height * scale / 100.0)))
        img = img.resize((nw, nh), 1)  # 1 == Image.LANCZOS
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    img.save(path, "PNG", optimize=False)
    return img.width, img.height


def capture(req, outdir):
    target = req.get("target") or "desktop"
    rec, how = resolve_window(target)
    scale = float(req.get("scale") or 100)
    max_width = int(req.get("max_width") or 0)
    frames = max(1, min(8, int(req.get("frames") or 1)))
    interval = max(0, int(req.get("interval_ms") or 350))
    region = req.get("region") or None
    stamp = time.strftime("%Y%m%d-%H%M%S") + ("-%03d" % (int(time.time() * 1000) % 1000))

    results = []
    extra = {}
    for i in range(frames):
        if rec is None and how == "desktop":
            vx, vy, vw, vh = virtual_screen()
            bx, by, bw, bh = vx, vy, vw, vh
        else:
            if rec is None:
                if how in ("game", "game-missing"):
                    # 游戏没开 / 窗口不在：不报错，回一帧桌面 + hint，让模型自己判断
                    hint = "没有找到 Minecraft 窗口（可能需要先启动游戏）。已改为截取桌面。"
                    rec = None
                    vx, vy, vw, vh = virtual_screen()
                    bx, by, bw, bh = vx, vy, vw, vh
                    extra = {"hint": hint}
                else:
                    raise RuntimeError("窗口没找到（target=%s, reason=%s）" % (target, how))
            else:
                c = rec["client"]
                bx, by, bw, bh = c["x"], c["y"], c["width"], c["height"]
                if bw <= 0 or bh <= 0:
                    bx, by, bw, bh = rec["x"], rec["y"], rec["width"], rec["height"]
        x, y, w, h = bx, by, bw, bh
        if isinstance(region, dict) and region:
            # region 以窗口/桌面左上角为原点，坐标单位=原始像素
            x = bx + int(region.get("x") or 0)
            y = by + int(region.get("y") or 0)
            w = int(region.get("width") or w)
            h = int(region.get("height") or h)
            w = min(w, bx + bw - x)
            h = min(h, by + bh - y)
            if w <= 0 or h <= 0:
                raise ValueError("region 超出窗口范围")
        img = grab_region(x, y, w, h)
        name = "frame-%s-%d.png" % (stamp, i)
        path = os.path.join(outdir, name)
        sw, sh = save_image(img, path, scale, max_width)
        results.append(
            {
                "path": os.path.abspath(path),
                "width": sw,
                "height": sh,
                "source": {"x": x, "y": y, "width": w, "height": h},
            }
        )
        if i < frames - 1:
            time.sleep(interval / 1000.0)

    # 先把新帧落盘，再和上一帧比较，给后台观察用
    if req.get("compare_with") and results:
        prev = read_png_rgb(req.get("compare_with"))
        cur = read_png_rgb(results[0]["path"])
        if prev is not None and cur is not None:
            stats = compare_pixels(prev, cur)
            results[0]["diff"] = stats

    return {
        "ok": True,
        "target": target,
        "resolved": how,
        "window": rec,
        "foreground": int(foreground_hwnd()),
        "cursor": cursor_pos(),
        "virtual_screen": dict(zip(("x", "y", "width", "height"), virtual_screen())),
        "frames": results,
        "game": next((w for w in list_windows() if is_game_window(w)), None),
        **extra,
    }


# ---------------------------------------------------------------- 动作


def do_actions(actions, settle_ms=0):
    done = []
    held_keys = []
    held_buttons = []
    for idx, act in enumerate(actions or []):
        if not isinstance(act, dict):
            raise ValueError("actions[%d] 不是对象" % idx)
        kind = (act.get("type") or act.get("action") or "").lower()
        if kind in ("move", "mousemove", "mouse_move"):
            dx = int(act.get("dx") or 0)
            dy = int(act.get("dy") or 0)
            done.append(mouse_move_rel(dx, dy, int(act.get("steps") or 1), int(act.get("gap_ms") or 8)))
        elif kind in ("look", "smooth_move", "turn"):
            dx = int(act.get("dx") or 0)
            dy = int(act.get("dy") or 0)
            ms = int(act.get("duration_ms") or act.get("ms") or 800)
            steps = int(act.get("steps") or 0)
            ease = act.get("ease", True) is not False
            done.append(mouse_move_smooth(dx, dy, ms, steps, ease))
        elif kind in ("move_by", "mouse_move_by"):
            dx = int(act.get("dx") or 0)
            dy = int(act.get("dy") or 0)
            duration = act.get("duration_ms")
            done.append(
                mouse_move_by(
                    dx,
                    dy,
                    None if duration is None else int(duration),
                    act.get("curve_px"),
                )
            )
        elif kind in ("move_abs", "mouse_abs", "moveto"):
            duration = act.get("duration_ms")
            done.append(
                mouse_move_abs(
                    int(act.get("x") or 0),
                    int(act.get("y") or 0),
                    None if duration is None else int(duration),
                    act.get("curve_px"),
                )
            )
        elif kind in ("click", "attack", "use"):
            btn = act.get("button") or ("left" if kind != "use" else "right")
            count = max(1, int(act.get("count") or 1))
            hold = max(10, int(act.get("hold_ms") or 60))
            for _ in range(count):
                done.append(mouse_button(btn, True))
                time.sleep(hold / 1000.0)
                done.append(mouse_button(btn, False))
                time.sleep(0.04)
        elif kind in ("button_down", "mousedown"):
            held_buttons.append(act.get("button") or "left")
            done.append(mouse_button(held_buttons[-1], True))
        elif kind in ("button_up", "mouseup"):
            b = act.get("button") or (held_buttons.pop() if held_buttons else "left")
            done.append(mouse_button(b, False))
        elif kind in ("wheel", "scroll"):
            done.append(mouse_wheel(int(act.get("amount") or act.get("dy") or 120)))
        elif kind in ("key", "press", "keypress"):
            keys = act.get("key") or act.get("keys") or act.get("name")
            if isinstance(keys, list):
                for k in keys:
                    done.append(key_press(k, int(act.get("hold_ms") or 40)))
            else:
                done.append(key_press(keys, int(act.get("hold_ms") or 40)))
        elif kind in ("keydown", "hold_start"):
            held_keys.append(act.get("key"))
            done.append(key_down(act.get("key")))
        elif kind in ("keyup", "hold_end"):
            k = act.get("key") or (held_keys.pop() if held_keys else None)
            done.append(key_up(k))
            if k in held_keys:
                held_keys.remove(k)
        elif kind in ("hold", "move_hold"):
            k = act.get("key")
            ms = max(10, int(act.get("ms") or 500))
            done.append(key_down(k))
            time.sleep(ms / 1000.0)
            done.append(key_up(k))
        elif kind in ("type", "text"):
            done.append(type_text(act.get("text") or ""))
        elif kind in ("sleep", "wait"):
            ms = max(0, int(act.get("ms") or 100))
            time.sleep(ms / 1000.0)
            done.append("sleep %sms" % ms)
        else:
            raise ValueError("未知动作类型: %s" % kind)
        if int(act.get("delay_ms") or 0) > 0:
            time.sleep(int(act.get("delay_ms")) / 1000.0)
    # 收起仍然按住的输入，避免“卡键”
    for k in held_keys:
        try:
            key_up(k)
            done.append("release %s" % k)
        except Exception:
            pass
    for b in held_buttons:
        try:
            mouse_button(b, False)
            done.append("release %s" % b)
        except Exception:
            pass
    if settle_ms > 0:
        time.sleep(settle_ms / 1000.0)
    return done


def act(req, outdir):
    target = req.get("target") or "game"
    rec, how = resolve_window(target)
    focused = False
    if rec is not None and how != "desktop" and bool(req.get("focus", True)):
        focused = focus_window(int(rec["hwnd"]))
    if req.get("dry_run"):
        return {
            "ok": True,
            "dry_run": True,
            "resolved": how,
            "window": rec,
            "focused": focused,
            "foreground": int(foreground_hwnd()),
            "cursor": cursor_pos(),
        }
    done = do_actions(req.get("actions") or [], int(req.get("settle_ms") or 0))
    res = {
        "ok": True,
        "resolved": how,
        "window": rec,
        "focused": focused,
        "foreground": int(foreground_hwnd()),
        "resolved_class": window_class(foreground_hwnd()),
        "resolved_title": window_title(foreground_hwnd()),
        "cursor": cursor_pos(),
        "done": done,
        "game": next((w for w in list_windows() if is_game_window(w)), None),
    }
    if req.get("capture", True):
        shot = capture(
            {
                "target": "game" if (how == "game" and res["game"]) else ("hwnd:%d" % int(rec["hwnd"]) if rec else "desktop"),
                "scale": req.get("scale") or 60,
                "max_width": req.get("max_width") or 0,
                "frames": 1,
            },
            outdir,
        )
        res["frames"] = shot["frames"]
        res["capture_target"] = shot["target"]
    return res


# ---------------------------------------------------------------- 入口


def emit(obj, result_path=None):
    """把结果写成单行 JSON：有 result_path 就原子写文件，否则写 stdout（手动调试用）。"""
    text = json.dumps(obj, ensure_ascii=True)
    if result_path:
        tmp = result_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, result_path)
    else:
        print(text)


def read_png_rgb(path):
    """读一张 PNG 成 RGB 像素；失败返回 None。"""
    try:
        from PIL import Image
        with Image.open(path) as im:
            return im.convert("RGB")
    except Exception:
        return None


def compare_pixels(prev, cur):
    """比较两张同尺寸 RGB 图：逐像素取最大通道差，统计平均差和“变化像素占比”。

    返回 {changed, mean_diff (0-255), diff_ratio (0-1), width, height}。
    """
    if prev is None or cur is None:
        return None
    if prev.size != cur.size:
        return {"changed": True, "mean_diff": 255.0, "diff_ratio": 1.0, "width": cur.width, "height": cur.height, "size_changed": True}
    import numpy as np
    a = np.asarray(prev, dtype=np.uint8)
    b = np.asarray(cur, dtype=np.uint8)
    delta = np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2)
    mean_diff = float(delta.mean())
    diff_ratio = float((delta > 8).mean())  # 单通道差 >8 的像素算“变了”
    return {
        "changed": bool(mean_diff > 1.0 or diff_ratio > 0.002),
        "mean_diff": round(mean_diff, 3),
        "diff_ratio": round(diff_ratio, 5),
        "width": cur.width,
        "height": cur.height,
    }


def compare_files(a_path, b_path):
    """单独比较两个文件（watch 用）。"""
    a = read_png_rgb(a_path)
    b = read_png_rgb(b_path)
    stats = compare_pixels(a, b)
    if stats is None:
        raise RuntimeError("无法读取图片：%s / %s" % (a_path, b_path))
    return {"ok": True, **stats}


def main():
    set_dpi_aware()
    req_path = sys.argv[1] if len(sys.argv) > 1 else None
    result_path = sys.argv[2] if len(sys.argv) > 2 else None
    try:
        if req_path:
            with open(req_path, "r", encoding="utf-8-sig") as f:
                raw = f.read()
        else:
            raw = sys.stdin.buffer.read().decode("utf-8-sig")
        req = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        emit({"ok": False, "error": "bad request: %s" % e}, result_path)
        return 2
    outdir = req.get("outdir") or os.path.join(os.getcwd(), "shots")
    cmd = (req.get("cmd") or "").lower()
    try:
        if cmd == "windows":
            wins = list_windows(bool(req.get("include_invisible")))
            result = {
                "ok": True,
                "windows": wins,
                "foreground": int(foreground_hwnd()),
                "cursor": cursor_pos(),
                "virtual_screen": dict(zip(("x", "y", "width", "height"), virtual_screen())),
            }
        elif cmd == "see":
            result = capture(req, outdir)
        elif cmd == "act":
            result = act(req, outdir)
        elif cmd == "compare":
            result = compare_files(req.get("a"), req.get("b"))
        elif cmd == "ping":
            result = {"ok": True, "pong": True, "virtual_screen": dict(zip(("x", "y", "width", "height"), virtual_screen()))}
        else:
            emit({"ok": False, "error": "unknown cmd: %s" % cmd}, result_path)
            return 2
    except Exception as e:
        emit({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, result_path)
        return 1
    emit(result, result_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
