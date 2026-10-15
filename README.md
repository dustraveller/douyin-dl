# 抖音作品下载（douyin-dl）

本地运行、带界面的抖音作品下载工具。后端用 Node + Playwright 驱动浏览器采集，前端是一个轻量的本地 Web 界面；另附一个命令行版本。

> 仅供个人学习、备份自己或已获授权的内容使用，请遵守平台条款与版权规定。

## 功能

- 输入用户主页链接 / `sec_uid` / `aweme_id` 采集，或按「用户名 / 抖音号」搜索用户
- 批量下载 **视频 / 图集 / 图文（图片+视频混合）**，可按高度选择清晰度
- 可选下载背景音乐（BGM）
- 两种下载模式（可同时勾选）：
  - **散件**：图片、视频、音频分别保存
  - **合成 MP4**：把图文作品合成为一个视频（需 ffmpeg），可设置每张图停留时长
- **登录态**：粘贴 Cookie 串 / JSON 导入，或从 Edge 自动导入 / 用 Edge 扫码登录
- **下载编队**：跨多个用户勾选作品，攒到一起批量下载
- 本地状态标记：每个作品显示已下载 / 部分缺失 / 未下载

## 环境要求

- Node.js ≥ 18（推荐 20+）
- Windows 体验最佳（「从 Edge 导入」为 Windows 特性；其余功能跨平台可用）
- 可选：ffmpeg（用于「合成 MP4」；留空则自动探测 PATH）

## 安装

```bash
npm install
npx playwright install chromium
```

## 使用（Web 界面）

```bash
node server.js
```

启动后自动打开 <http://localhost:8787>。

常用启动参数：

```bash
node server.js --port 9000 --out "D:\抖音下载" --no-open
```

| 参数 | 说明 |
| --- | --- |
| `-p, --port <端口>` | 监听端口（默认读取 config.json，初始 8787；被占用会自动向后重试） |
| `-o, --out <目录>` | 本次启动的下载目录（不写入配置） |
| `--no-open` | 启动后不自动打开浏览器 |
| `-h, --help` | 显示帮助 |

操作步骤：

1. 设置「下载目录」并点「保存设置」。
2. 配置登录态：点「导入 Cookie」粘贴，或「用 Edge 登录」扫码（**用户名 / 抖音号搜索需要登录**）。
3. 顶部输入框粘贴链接 / `sec_uid` / 作品ID，或切到「用户名 / 抖音号」后输入关键词 → 点「识别 / 搜索」。
4. 在「检索结果」勾选作品 → 「下载选中」；或「加入编队」跨用户攒着一起下。
5. 在「下载状态」查看进度与日志。

> 关键词搜索时，抖音要求浏览器窗口处于焦点，会**短暂弹出**一个浏览器窗口自动完成搜索，结束后自动关闭；粘贴链接采集不会弹窗。

## 命令行（CLI）

```bash
node dl.js <用户链接或 sec_uid> [选项]
```

| 选项 | 说明 |
| --- | --- |
| `--out <目录>` | 输出目录（默认 `downloads`） |
| `--quality <N>` | 目标清晰度高度，如 `720`（默认取最高） |
| `--works <id,id>` | 只下载指定作品 `aweme_id`（默认全部） |
| `--sort <old\|new>` | 下载顺序，`old` 旧→新（默认）/ `new` 新→旧 |
| `--cookies <file>` | 登录态 storageState JSON（默认 `./cookies.json`，存在才用） |
| `--headless` | 无头模式（默认有头） |
| `--no-bgm` | 不下载背景音乐 |
| `-h, --help` | 显示帮助 |

示例：

```bash
node dl.js https://www.douyin.com/user/MS4wLjABxxxx
node dl.js https://www.douyin.com/user/MS4wLjABxxxx --sort new --headless --no-bgm
```

## 目录结构

```
server.js          本地服务 + Web API
lib.js             采集 / 解析 / 下载核心（Playwright）
dl.js              命令行入口
demo.js            最小采集示例
public/index.html  前端界面
cookies.json       登录态（运行时生成，不提交）
cache.json         采集缓存与编队（运行时生成，不提交）
config.json        本机配置（运行时生成，不提交）
downloads/         默认下载目录
```

## 常见问题

- **搜索无结果**：抖音用户搜索需要登录态，请先导入 Cookie 或用 Edge 扫码登录。
- **搜索时弹出浏览器窗口**：抖音要求窗口焦点，属正常现象；用链接采集不受影响。
- **「合成 MP4」失败**：检查 ffmpeg——设置里的「ffmpeg」既可填 `ffmpeg.exe`，也可填它所在目录，留空则自动探测。
- **端口被占用**：服务会自动向后尝试其它端口（最多 20 个）。

## 声明

本项目仅用于学习与个人备份，请勿用于批量抓取、传播他人作品等侵犯版权或违反平台条款的行为。
