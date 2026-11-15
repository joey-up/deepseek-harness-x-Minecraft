# 屏幕之眼 · desktop-eye

让 [DeepSeek Harness](https://github.com/deepseek-ai) 里的 AI **看见你的 Windows 屏幕**，并在你允许时**用真实鼠标键盘操作它**。

> ⚠️ **这是高权限插件。** 它会把屏幕画面交给模型，并发送真实的鼠标/键盘输入（作用于整台电脑，不只作用于某个窗口）。只在你自己信任的环境中安装，安装前请读完下面的「安全与隐私」。

## 能力

| 工具 | 作用 | 会改变电脑吗 |
| --- | --- | --- |
| `screen_see` | 截屏：整个桌面 / 指定窗口 / 前台窗口 / 游戏窗口；支持局部裁剪、连续多帧 | 只读 |
| `screen_act` | 发真实鼠标键盘：转视角、点击、拖动、WASD、打字、滚轮；每次结束自动松开所有按键 | 会 |
| `screen_windows` | 列出可见窗口（hwnd、标题、类名、pid、位置、是否前台） | 只读 |
| `screen_watch` | 后台持续观察：定时截低清帧做像素差分，明显变化时才叫醒模型复看 | 只读 |

截图会作为图片直接进入对话，模型能看见；同时落盘成 PNG，路径写在工具结果里，可反复 `read_image` 回看。

## 安全与隐私（务必阅读）

- **画面会被模型看到**：截图进入当前会话，可能被上传到模型服务。不要对着这个插件展示密码、私钥、身份证件等敏感内容。
- **输入是全局的**：`screen_act` 通过 Windows `SendInput` 发送事件，谁在前台就发给谁。插件会尽量先切目标窗口，但不能保证万无一失。
- **后台观察**：`screen_watch` 会周期性截低分辨率画面做本地像素比对；只有变化明显时才会唤醒模型（默认 3 分钟冷却），但请在不使用时 `stop`。
- **只在本机使用**：插件不联网、不读取用户文件，截图与请求文件只写到本地目录。
- **仅在用户明确要求时操作**：这是使用约定，模型行为无法由插件强制，所以请只在你信任的会话里启用。

## 安装

要求：Windows 10/11、DeepSeek Harness（`dsh`）、带 Pillow 的 Python（Harness 自带运行时已满足，插件会自动探测）。

1. 把本仓库放到一个目录，例如 `C:\Users\<你>\Documents\desktop-eye`。
2. 在 Harness 里安装它（需要一次插件管理审批）：

```text
plugin_manager action=install_bundle target=<上面那个绝对路径>
```

3. 启用：

```text
plugin_manager action=set_plugin target=include:desktop-eye enabled=true
```

安装成功后，模型侧会出现 `screen_see` / `screen_act` / `screen_windows` / `screen_watch` 四个工具。

> 如果你改了插件代码，需要把插件停用再启用一次才会加载新模块。

### 可选：手动指定 Python

插件默认依次尝试：`DSH_DESKTOP_EYE_PYTHON` → `DSH_PYTHON` → `.dsh` 运行时自带的 Python → 系统 `python`/`py`。都不行时，在 `cordis.patch.yml` 的插件行 `config` 里指定：

```yaml
- insert:
    - id: desktop-eye
      name: desktop-eye
      config:
        python: 'C:\Python312\python.exe'
        shotDir: 'C:\Users\me\shots'
```

## 用法示例

```text
screen_see { target: "game" }                     # 看 Minecraft 窗口
screen_see { target: "desktop", scale: 30 }       # 看整个桌面（省 token）
screen_see { target: "hwnd:123456", region: { x: 0, y: 0, width: 400, height: 300 } }

screen_act { target: "game", actions: [
  { type: "look", dx: 400, dy: 0, duration_ms: 600 },   # 平滑转视角
  { type: "key", key: "W" },
  { type: "click", button: "right", hold_ms: 200 },
  { type: "type", text: "hello" }
] }

screen_windows {}

screen_watch { action: "start", target: "game", interval_ms: 20000, threshold: 0.02 }
screen_watch { action: "status" }
screen_watch { action: "stop" }
```

`screen_act` 支持的动作：`look`（平滑转视角）、`move`、`move_by`、`move_abs`（贝塞尔弧线 + ease-in-out 的拟人光标移动）、`click`、`button_down/up`、`wheel`、`key`/`keys`、`keydown/keyup`、`hold`、`type`、`sleep`。

## 工作原理

- **截屏**：内置 Python + Pillow（`ImageGrab`，`all_screens=True`，进程开启 Per-Monitor DPI 感知，坐标为物理像素）。
- **输入**：Python 用 `SendInput` 发送扫描码键盘事件与鼠标事件；结束时强制释放所有按住的键，避免卡键。
- **进程通信**：Windows 沙箱禁止带管道的 `spawn`，所以 Host 与助手之间用「请求 JSON 文件 + 结果 JSON 文件」，不经过 stdin/stdout。
- **图片**：PNG 经 Harness 的 `attachments.saveImage()` 落盘，再作为 `{ type: "image", attachment }` content block 返回给模型。
- **后台观察**：低分辨率帧 + 逐像素差分（Pillow），变化超过阈值且冷却结束才 `agent.followup()` 唤醒会话。

## 目录

```
desktop-eye/
  index.js                 # Host 插件：注册四个工具
  watch.cjs                # 后台观察模块（CJS，被 index.js require）
  helper/screen_helper.py  # 截屏 / 枚举窗口 / SendInput / 像素比较
  cordis.patch.yml         # bundle 补丁：插入 id=desktop-eye
  package.json             # bundle 清单
  locale/{zh,en}.json      # 插件管理里显示的名称与描述
  icon.svg                 # 图标
  schema-guard.mjs         # DSH JSON Schema 子集守卫
  validate-schema.mjs      # 校验四个工具的 schema
  smoke-test.mjs           # 用假 ctx 真跑一遍 screen_see / screen_act / screen_windows
  watch-test.mjs           # 用假 agent 验证变化检测与 followup
```

## 本地自测

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node validate-schema.mjs   # schema 合法
& $node smoke-test.mjs        # 真截屏 + 真发键
& $node watch-test.mjs        # 变化检测（会真的截屏约 20 秒）
```

## 已知限制

- 只支持 **Windows**（依赖 `SendInput`、`ImageGrab`、DPI API）。
- 听不到声音；低清观察帧读不清小字，唤醒后插件会重新截高清图。
- 输入无法区分「用户按的」和「插件发的」，操作期间请勿同时使用键盘鼠标。
- 截图目录默认在 Host 进程工作目录下的 `desktop-eye-shots/`，6 小时后自动清理。

## License

MIT，见 [LICENSE](LICENSE)。
