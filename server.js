// 抖音下载 本地服务：Node HTTP + Playwright 后端，浏览器打开页面操作
// 启动: node server.js  然后浏览器访问 http://localhost:8787
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile, execFileSync } = require('child_process');
const lib = require('./lib');

// ---------- 命令行参数(CLI 启动模式) ----------
//   node server.js [--port 8787] [--out <dir>] [--no-open] [--help]
const ARGV = process.argv.slice(2);
const ARG = { port: null, out: null, open: true, help: false };
for (let i = 0; i < ARGV.length; i++) {
  const a = ARGV[i];
  if (a === '--port' || a === '-p') ARG.port = parseInt(ARGV[++i], 10) || null;
  else if (a === '--out' || a === '-o') ARG.out = ARGV[++i];
  else if (a === '--no-open') ARG.open = false;
  else if (a === '--help' || a === '-h') ARG.help = true;
}
if (ARG.help) {
  console.log(`
抖音作品下载 · 本地服务 (CLI 启动模式)

用法:
  node server.js [选项]

选项:
  -p, --port <端口>   监听端口 (默认取 config.json 中的 port, 初始 8787)
  -o, --out  <目录>   下载目录 (仅本次启动生效, 不写入配置文件)
      --no-open       启动后不自动打开浏览器
  -h, --help          显示本帮助

说明:
  未显式指定 --port 时, 若端口被占用会自动向后尝试其它端口(最多 20 个),
  并把最终可用的端口写入 config.json 作为下次默认。

示例:
  node server.js
  node server.js --port 9000 --out "D:\\抖音下载"
  node server.js --no-open
`);
  process.exit(0);
}

const DEFAULT_PORT = 8787;
const COOKIES = path.join(__dirname, 'cookies.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_FILE = path.join(__dirname, 'cache.json'); // 解析结果 + 编队(落盘, 刷新不丢)
const CONFIG_FILE = path.join(__dirname, 'config.json'); // 用户配置(下载目录等)

// ---------- 配置(下载目录 + 端口 + ffmpeg + 合成参数 + 请求超时) ----------
let config = {
  out: path.join(__dirname, 'downloads'),
  port: 8787,
  ffmpeg: '',        // ffmpeg 可执行文件路径(留空则自动探测)
  interval: 3,       // 合成视频时每张静态图片的停留秒数
  collectTimeout: 120, // 单次采集无响应多久后自动取消(秒)
};
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) { saveConfig(); return; }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''); // 容忍 BOM
    const c = JSON.parse(raw);
    if (c && typeof c.out === 'string' && c.out.trim()) config.out = c.out;
    if (c && Number.isInteger(c.port) && c.port > 0 && c.port < 65536) config.port = c.port;
    if (c && typeof c.ffmpeg === 'string') config.ffmpeg = c.ffmpeg.trim();
    if (c && typeof c.interval === 'number' && c.interval > 0) config.interval = c.interval;
    if (c && Number.isInteger(c.collectTimeout) && c.collectTimeout > 0) config.collectTimeout = c.collectTimeout;
  } catch (e) { console.error('[server] 读配置失败:', e.message); }
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) { console.error('[server] 写配置失败:', e.message); }
}

// ---------- ffmpeg 探测 + 图文合成 ----------
// 解析 ffmpeg 可执行文件: 依次尝试 配置值 -> 常见本地位置 -> PATH
// 允许填"目录"或"可执行文件"(目录则自动补 ffmpeg.exe / bin/ffmpeg.exe)
function resolveFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const cands = ['F:\\download\\三巡\\ffmpeg-master-latest-win64-gpl-shared'];
  if (config.ffmpeg) cands.unshift(config.ffmpeg);
  const expand = [];
  for (const c of cands) {
    if (!c || typeof c !== 'string' || !c.trim()) continue;
    expand.push(c);
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
        expand.push(path.join(c, exe), path.join(c, 'bin', exe));
      }
    } catch { /* ignore */ }
  }
  for (const c of expand) {
    try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
  }
  try {
    const r = execFileSync('where', ['ffmpeg'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim();
    if (r && fs.existsSync(r)) return r;
  } catch {}
  return null;
}
// 同名目录下的 ffprobe(存在才返回)
function ffprobeOf(ffmpegPath) {
  try {
    const p = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}
function runFfmpeg(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, so, se) => {
      if (err) return reject(new Error(String(se || so || err.message).trim().split('\n').slice(-3).join(' ').slice(-400)));
      resolve(so);
    });
  });
}
// 把图文作品按"网页播放"顺序合成为一个 MP4: 静态图各停留 intervalSec 秒, 视频段用其真实时长
// clips: [{ img:bool, file }]  bgmFile: 可选的背景音乐文件
async function composeWork(a, dir, base, clips, bgmFile, intervalSec) {
  const ff = resolveFfmpeg();
  if (!ff) throw new Error('未找到 ffmpeg，请在设置中填写 ffmpeg.exe 路径或加入 PATH');
  const first = (a.images || []).find(it => !it.video);
  let W = (first && first.width) || 1080, H = (first && first.height) || 1920;
  const long = Math.max(W, H);
  if (long > 1920) { const k = 1920 / long; W = Math.round(W * k); H = Math.round(H * k); }
  W -= W % 2; H -= H % 2;
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`;
  const tmp = path.join(dir, `.dy_merge_${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const parts = [];
    let n = 0;
    for (const c of clips) {
      n++;
      const part = path.join(tmp, `p${String(n).padStart(3, '0')}.mp4`);
      const base_args = ['-y'];
      if (c.img) base_args.push('-loop', '1', '-i', c.file, '-t', String(intervalSec));
      else base_args.push('-i', c.file);
      base_args.push('-r', '30', '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', part);
      await runFfmpeg(ff, base_args);
      parts.push(part);
    }
    const listFile = path.join(tmp, 'list.txt');
    fs.writeFileSync(listFile, parts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const merged = path.join(tmp, 'merged.mp4');
    await runFfmpeg(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', merged]);
    const outPath = path.join(dir, lib.mergedName(base));
    if (bgmFile && fs.existsSync(bgmFile)) {
      const begin = ((a.image_album_music_info && a.image_album_music_info.begin_time) || 0) / 1000;
      const args = ['-y', '-i', merged, '-stream_loop', '-1'];
      if (begin > 0) args.push('-ss', String(begin));
      args.push('-i', bgmFile, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outPath);
      await runFfmpeg(ff, args);
    } else {
      fs.copyFileSync(merged, outPath);
    }
    return outPath;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ---------- 共享浏览器 + 缓存 ----------
let shared = null;
let collecting = false; // 采集串行化
let activeCollect = null; // 当前采集任务 { page, aborted, reason }
// 取消当前采集: 标记并关闭页面(使进行中的等待/导航立即抛错)
function cancelCollect(reason) {
  if (activeCollect && !activeCollect.aborted) {
    activeCollect.aborted = true;
    activeCollect.reason = reason || '已取消';
    try { activeCollect.page.close(); } catch {}
    console.error('[server] 采集已取消:', activeCollect.reason);
    return true;
  }
  return false;
}
const workCache = new Map(); // aweme_id -> 原始作品对象(所有用户累积)
let current = { type: null, ids: [] }; // 当前视图: 类型 + 作品顺序
let queue = []; // 下载编队: 有序的 aweme_id 列表(可跨用户累积)
let job = { running: false, stopRequested: false, total: 0, done: 0, results: [], log: [] };

async function ensureShared() {
  if (!shared) shared = await lib.launch({ headless: true, cookies: COOKIES });
  return shared;
}
// 关闭共享浏览器(导入/退出登录后需要重新加载登录态)
async function closeShared() {
  const s = shared; shared = null;
  if (s) { try { await s.context.close(); } catch {} try { await s.browser.close(); } catch {} }
}
// 关键词搜索用户: 抖音的页内搜索框在无头浏览器下输入/回车会被前端忽略(依赖窗口焦点),
// 因此用可见浏览器完成搜索, 结束后立即关闭; 作品采集仍走无头共享浏览器。
async function searchUsersHeaded(keyword, mode) {
  const { browser, context } = await lib.launch({ headless: false, cookies: COOKIES });
  try {
    const page = await context.newPage();
    return await lib.searchUsers(page, keyword, { mode });
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

// ---------- 登录态 ----------
const LOGIN_PROFILE = path.join(__dirname, 'edge-profile'); // "用 Edge 登录" 使用的独立配置目录
let loginJob = { state: 'idle', error: '', startedAt: 0 }; // idle|opening|waiting|ok|timeout|error
function readCookies() {
  try { const d = JSON.parse(fs.readFileSync(COOKIES, 'utf8')); return Array.isArray(d.cookies) ? d.cookies : []; } catch { return []; }
}
let me = null; // 当前登录用户资料缓存 { nickname, secUid, uniqueId, avatar }
function loginState() {
  const cookies = readCookies();
  return {
    loggedIn: cookies.some(c => /sessionid/i.test(c.name) && c.value),
    cookieCount: cookies.length,
    me: me || null,
  };
}
// 后台获取当前登录用户资料(昵称/头像), 供前端备注显示; 失败静默
async function refreshMe() {
  if (!loginState().loggedIn) { me = null; return; }
  try {
    const page = await (await ensureShared()).context.newPage();
    try {
      const p = await lib.getSelfProfile(page);
      if (p && p.nickname) {
        me = p;
        console.log(`[server] 登录用户: ${p.nickname}${p.uniqueId ? '（抖音号 ' + p.uniqueId + '）' : ''}`);
      }
    } finally { await page.close().catch(() => {}); }
  } catch (e) { console.error('[server] 获取登录用户资料失败:', e.message); }
}


// ---------- 缓存读写 ----------
// 落盘: 全部作品对象(多用户) + 当前视图 + 编队
function persistCache() {
  const works = [...workCache.values()];
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ view: current, works, queue })); } catch (e) { console.error('[server] 写缓存失败:', e.message); }
}
function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return;
  try {
    const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    current = d.view || { type: null, ids: [] };
    for (const a of d.works || []) workCache.set(String(a.aweme_id), a);
    queue = Array.isArray(d.queue) ? d.queue.map(String) : [];
    console.log(`[server] 已加载缓存: 视图 ${current.ids.length} 个作品 / 编队 ${queue.length} 个`);
  } catch (e) { console.error('[server] 读缓存失败:', e.message); }
}

// 由 workCache + current 组装返回给前端的视图(每次重算本地状态)
function buildResult() {
  const works = current.ids.map(id => workCache.get(id)).filter(Boolean);
  const author = works[0] ? lib.summarize(works[0]).author : { nickname: '', secUid: '' };
  const list = works.map(a => {
    const s = lib.summarize(a);
    s.local = lib.localStatus(a, { out: config.out, quality: 0, bgm: true });
    return s;
  });
  return { type: current.type, author, count: list.length, works: list };
}

// 编队详情(带作者/描述, 供前端展示; 按加入顺序)
function buildQueue() {
  const items = queue.map(id => {
    const a = workCache.get(id);
    if (!a) return { id, missing: true };
    const s = lib.summarize(a);
    return { id, author: s.author.nickname, desc: s.desc, type: s.type, date: s.date };
  });
  return { queue: items, count: items.length };
}

// ---------- 业务 ----------
async function doCollect(input, mode) {
  if (collecting) throw new Error('正在处理上一个请求，请稍候');
  collecting = true;
  const timeoutMs = (config.collectTimeout || 120) * 1000;
  let timer = null;
  let page = null;
  try {
    // "抖音号"模式下, 非链接输入一律当作号码检索(避免把长数字误判成作品ID)
    const isUrl = /^https?:\/\//i.test(String(input).trim());
    // 链接/ID 才需要无头共享浏览器页面(解析短链/采集); 纯关键词搜索不进这里
    const s0 = String(input).trim();
    const looksLikeLink = /^https?:\/\//i.test(s0) || /^MS4wLjAB/.test(s0) || /^\d{15,}$/.test(s0);
    let c = null;
    if (looksLikeLink && !(mode === 'id' && !isUrl)) {
      page = await (await ensureShared()).context.newPage();
      c = await lib.resolveInput(page, input);
    }
    if (!c) {
      // 非链接/ID: 当作关键词, 搜索用户(仿官方搜索页; 需可见浏览器窗口焦点)
      if (page) { try { await page.close(); } catch {} page = null; }
      const m = mode === 'id' ? 'id' : 'name';
      const users = await searchUsersHeaded(input, m);
      current = { type: 'search', ids: [] };
      persistCache();
      const res = { type: 'search', keyword: input, mode: m, count: users.length, users };
      if (!users.length && !loginState().loggedIn) res.hint = '未登录：抖音用户搜索需登录态，请先在“登录态”处导入 Cookie 或用 Edge 登录';
      return res;
    }
    activeCollect = { page, aborted: false, reason: '' };
    timer = setTimeout(() => cancelCollect(`采集超时（${config.collectTimeout || 120}s 无响应）`), timeoutMs);
    let works = [];
    if (c.kind === 'user') {
      const map = await lib.collectWorks(page, c.url);
      works = [...map.values()];
    } else if (c.kind === 'video') {
      const a = await lib.collectOne(page, c.awemeId);
      if (!a) throw new Error('未获取到作品详情（可能需登录或链接已失效）');
      works = [a];
    }
    works = lib.sortWorks(works, 'old');
    for (const a of works) workCache.set(String(a.aweme_id), a);
    current = { type: c.kind, ids: works.map(a => String(a.aweme_id)) };
    persistCache();
    return buildResult();
  } catch (e) {
    if (activeCollect && activeCollect.aborted) throw new Error(activeCollect.reason || '已取消');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    activeCollect = null;
    if (page) { try { await page.close(); } catch {} }
    collecting = false;
  }
}

// 按指定排序重排待下载 id (与前端列表排序一致: old/new/count-desc/count-asc)
function orderIds(ids, sort) {
  const timeOf = id => { const a = workCache.get(String(id)); if (!a) return 0; return a.create_time || Number(BigInt(a.aweme_id) >> 32n); };
  const cntOf = id => { const a = workCache.get(String(id)); if (!a) return 0; return (a.images && a.images.length) || (a.video ? 1 : 0); };
  const cmp = sort === 'new' ? (x, y) => timeOf(y) - timeOf(x)
    : sort === 'count-desc' ? (x, y) => cntOf(y) - cntOf(x)
    : sort === 'count-asc' ? (x, y) => cntOf(x) - cntOf(y)
    : (x, y) => timeOf(x) - timeOf(y); // old(默认): 旧→新
  return [...ids].sort(cmp);
}

async function doDownload(ids, opt) {
  if (job.running) throw new Error('已有下载任务进行中');
  ids = orderIds(ids, opt.sort); // 按当前列表排序确定下载先后顺序
  const modes = Array.isArray(opt.modes) && opt.modes.length ? opt.modes : ['raw'];
  const wantRaw = modes.includes('raw');       // 散件下载(原始图片/分段视频)
  const wantCompose = modes.includes('compose'); // 模拟下载(合成单个 MP4)
  const intervalSec = (opt.interval && opt.interval > 0) ? opt.interval : (config.interval || 3);
  const ctx = (await ensureShared()).context;
  job = { running: true, stopRequested: false, total: ids.length, done: 0, results: [], log: [] };
  (async () => {
    for (const id of ids) {
      if (job.stopRequested) break;
      const a = workCache.get(String(id));
      if (!a) { job.results.push({ id, ok: 0, skip: 0, fail: 0, files: [], error: '作品未缓存，请重新解析' }); job.done++; continue; }
      const author = (a.author && a.author.nickname) || 'unknown';
      const base = lib.workBase(a);
      const dir = path.join(opt.out, lib.sanitize(author, 40));
      fs.mkdirSync(dir, { recursive: true });
      const items = lib.planWork(a, opt.quality, opt.bgm);
      const res = { id, desc: a.desc || '', ok: 0, skip: 0, fail: 0, files: [] };
      const created = []; // 本次新建的素材文件(仅"只合成"模式下用于合成后清理)
      for (const it of items) {
        if (job.stopRequested) break;
        const fname = lib.fileNameFor(base, it);
        const fpath = path.join(dir, fname);
        if (fs.existsSync(fpath) && fs.statSync(fpath).size > 0) {
          res.skip++; res.files.push({ name: fname, kind: it.kind, status: 'skip' });
          continue;
        }
        try {
          const resp = await ctx.request.get(it.url, { headers: { referer: 'https://www.douyin.com/' }, timeout: 120000 });
          if (!resp.ok()) throw new Error('HTTP ' + resp.status());
          fs.writeFileSync(fpath, await resp.body());
          res.ok++; res.files.push({ name: fname, kind: it.kind, status: 'ok', size: fs.statSync(fpath).size });
          created.push(fpath);
          job.log.push(`✓ ${fname}`);
        } catch (e) {
          res.fail++; res.files.push({ name: fname, kind: it.kind, status: 'fail', message: e.message });
          job.log.push(`✗ ${fname}: ${e.message}`);
        }
      }
      // ---- 合成(仿网页播放: 每张静态图停留 intervalSec 秒, 视频段用真实时长, 顺序同数组) ----
      let composeOk = false;
      if (wantCompose && !job.stopRequested && lib.workType(a) !== 'video') {
        const mergedName = lib.mergedName(base);
        const mergedPath = path.join(dir, mergedName);
        const clips = items
          .filter(it => it.kind === 'image' || it.kind === 'video')
          .map(it => ({ img: it.kind === 'image', file: path.join(dir, lib.fileNameFor(base, it)) }))
          .filter(c => fs.existsSync(c.file) && fs.statSync(c.file).size > 0);
        const bgmItem = items.find(it => it.kind === 'audio');
        const bgmFile = bgmItem ? path.join(dir, lib.fileNameFor(base, bgmItem)) : null;
        if (clips.length && fs.existsSync(mergedPath) && fs.statSync(mergedPath).size > 0) {
          res.skip++; res.files.push({ name: mergedName, kind: 'merged', status: 'skip' });
          res.merged = 'skip'; composeOk = true;
        } else if (clips.length) {
          try {
            await composeWork(a, dir, base, clips, bgmFile, intervalSec);
            res.ok++; res.files.push({ name: mergedName, kind: 'merged', status: 'ok', size: fs.statSync(mergedPath).size });
            res.merged = 'ok'; composeOk = true;
            job.log.push(`✓ ${mergedName} (合成)`);
          } catch (e) {
            res.fail++; res.files.push({ name: mergedName, kind: 'merged', status: 'fail', message: e.message });
            res.merged = 'fail';
            job.log.push(`✗ ${mergedName}: ${e.message}`);
          }
        }
      }
      // 只勾选"合成"时: 合成成功后删除散件素材, 目录里只留合成视频
      if (!wantRaw && composeOk) {
        for (const f of created) { try { fs.unlinkSync(f); } catch {} }
      }
      job.results.push(res);
      job.done++;
    }
    job.running = false;
    job.stopped = job.stopRequested;
    job.log.push('__DONE__');
  })();
  return { started: true, total: ids.length };
}

// ---------- HTTP 工具 ----------
// 弹本机"资源管理器"文件夹选择框(Windows), 返回所选绝对路径; 取消返回 null
// 异步执行(不阻塞事件循环), 用户选择期间服务仍可响应其他请求
function pickDir(initial) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const tmp = os.tmpdir();
    const stamp = process.pid + '_' + Date.now();
    const ps1 = path.join(tmp, `dy_pick_${stamp}.ps1`);
    const outFile = path.join(tmp, `dy_pick_${stamp}.txt`);
    // 脚本保持纯 ASCII; 中文路径经 UTF-8 文件回传, 规避控制台编码问题
    const script =
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null\n' +
      '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog\n' +
      "$dlg.Description = 'Select download folder'\n" +
      '$dlg.ShowNewFolderButton = $true\n' +
      "if ($args.Count -ge 1 -and $args[0]) { try { $dlg.SelectedPath = $args[0] } catch {} }\n" +
      '$res = $dlg.ShowDialog()\n' +
      'if ($res -eq [System.Windows.Forms.DialogResult]::OK) {\n' +
      `  [System.IO.File]::WriteAllText('${outFile}', $dlg.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))\n` +
      '}\n';
    const cleanup = () => {
      try { fs.unlinkSync(ps1); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
    };
    try { fs.writeFileSync(ps1, script, 'utf8'); } catch { return resolve(null); }
    exec(`powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "${ps1}" "${initial || ''}"`,
      { timeout: 300000 }, () => {
        let sel = null;
        try { sel = fs.readFileSync(outFile, 'utf8').trim(); } catch {}
        cleanup();
        resolve(sel || null);
      });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => (buf += c));
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
  });
}
function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}
function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const ct = ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct });
    res.end(data);
  });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (req.method === 'GET' && u.pathname === '/api/img') {
      const target = u.searchParams.get('u');
      if (!target) { res.writeHead(400); res.end(); return; }
      const ctx = (await ensureShared()).context;
      const r = await ctx.request.get(target, { headers: { referer: 'https://www.douyin.com/' }, timeout: 30000 });
      if (!r.ok()) { res.writeHead(r.status()); res.end(); return; }
      const buf = await r.body();
      res.writeHead(200, { 'content-type': r.headers()['content-type'] || 'image/jpeg', 'cache-control': 'max-age=3600' });
      return res.end(buf);
    }
    if (req.method === 'POST' && u.pathname === '/api/collect') {
      const body = await readBody(req);
      // 页面刷新/关闭 -> 连接断开即视为"强制取消"当前采集
      let clientGone = false;
      const onClose = () => { if (!res.writableEnded) { clientGone = true; cancelCollect('客户端已断开（刷新）'); } };
      res.on('close', onClose);
      try {
        const data = await doCollect(body.input, body.mode);
        if (clientGone) return; // 客户端已断开, 无需回包
        return sendJson(res, 200, { ok: true, ...data });
      } catch (e) {
        if (clientGone) return;
        return sendJson(res, 400, { ok: false, error: e.message });
      } finally {
        res.off('close', onClose);
      }
    }
    // 手动取消当前采集(前端"取消"按钮)
    if (req.method === 'POST' && u.pathname === '/api/cancel') {
      const cancelled = cancelCollect('用户取消');
      return sendJson(res, 200, { ok: true, cancelled, collecting });
    }
    // 读取上次解析结果(页面刷新用), 不重新打开浏览器
    if (req.method === 'GET' && u.pathname === '/api/state') {
      if (!current.ids.length) return sendJson(res, 200, { ok: true, empty: true });
      return sendJson(res, 200, { ok: true, ...buildResult() });
    }
    // 仅重算本地下载状态(下载完成后调用, 不重新抓取)
    if (req.method === 'GET' && u.pathname === '/api/refresh') {
      if (!current.ids.length) return sendJson(res, 200, { ok: true, empty: true });
      return sendJson(res, 200, { ok: true, ...buildResult() });
    }
    if (req.method === 'POST' && u.pathname === '/api/download') {
      const body = await readBody(req);
      try {
        const r = await doDownload(body.ids || [], {
          out: config.out,
          quality: parseInt(body.quality, 10) || 0,
          bgm: body.bgm !== false,
          sort: body.sort, // 与列表一致的排序, 决定下载先后
          modes: Array.isArray(body.modes) ? body.modes : ['raw'], // ['raw','compose']
          interval: parseFloat(body.interval) || config.interval, // 合成时每张静态图秒数
        });
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }
    // ---------- 配置(下载地址 + ffmpeg + 合成参数 + 采集超时) ----------
    if (req.method === 'GET' && u.pathname === '/api/config') {
      return sendJson(res, 200, {
        ok: true,
        out: config.out,
        ffmpeg: config.ffmpeg,
        ffmpegResolved: resolveFfmpeg() || '',
        interval: config.interval,
        collectTimeout: config.collectTimeout,
        ...loginState(),
      });
    }
    // 打开本机"资源管理器"文件夹选择框(仅本机可用), 返回所选路径
    if (req.method === 'POST' && u.pathname === '/api/pick-dir') {
      const sel = await pickDir(config.out);
      if (!sel) return sendJson(res, 200, { ok: false, canceled: true });
      return sendJson(res, 200, { ok: true, out: sel });
    }
    if (req.method === 'POST' && u.pathname === '/api/config') {
      const body = await readBody(req);
      if (body.out !== undefined) {
        const out = String(body.out || '').trim();
        if (!out) return sendJson(res, 400, { ok: false, error: '下载目录不能为空' });
        config.out = path.resolve(out);
        try { fs.mkdirSync(config.out, { recursive: true }); } catch (e) { return sendJson(res, 400, { ok: false, error: '目录不可用: ' + e.message }); }
      }
      if (body.ffmpeg !== undefined) config.ffmpeg = String(body.ffmpeg || '').trim();
      if (body.interval !== undefined) {
        const iv = parseFloat(body.interval);
        if (Number.isFinite(iv) && iv > 0) config.interval = iv;
      }
      if (body.collectTimeout !== undefined) {
        const ct = parseInt(body.collectTimeout, 10);
        if (Number.isInteger(ct) && ct > 0) config.collectTimeout = ct;
      }
      saveConfig();
      return sendJson(res, 200, {
        ok: true,
        out: config.out,
        ffmpeg: config.ffmpeg,
        ffmpegResolved: resolveFfmpeg() || '',
        interval: config.interval,
        collectTimeout: config.collectTimeout,
        ...loginState(),
      });
    }
    // ---------- 登录态 ----------
    // 导入 Cookie(粘贴): 支持 storageState JSON / 扩展导出数组 / 原始 Cookie 字符串
    if (req.method === 'POST' && u.pathname === '/api/cookies') {
      const body = await readBody(req);
      try {
        const state = lib.parseCookies(body.data);
        if (!state.cookies.length) return sendJson(res, 400, { ok: false, error: '未解析到任何 cookie' });
        fs.writeFileSync(COOKIES, JSON.stringify(state), 'utf8');
        await closeShared();
        // 反馈识别到的关键 Cookie, 便于用户确认导入是否有效
        const KEY = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'ttwid', 'odin_tt', 'uid_tt', 'passport_csrf_token'];
        const have = new Set(state.cookies.map(c => c.name));
        const keyCookies = KEY.filter(k => have.has(k));
        me = null;
        await refreshMe(); // 拉取登录用户昵称/头像
        return sendJson(res, 200, { ok: true, imported: state.cookies.length, keyCookies, ...loginState() });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }
    // 清除登录态
    if (req.method === 'POST' && u.pathname === '/api/logout') {
      try { fs.unlinkSync(COOKIES); } catch {}
      me = null;
      await closeShared();
      return sendJson(res, 200, { ok: true, ...loginState() });
    }
    // 从系统 Edge 自动导入登录态(需 Edge 完全关闭)
    if (req.method === 'POST' && u.pathname === '/api/edge-import') {
      let running = false;
      try { running = lib.edgeRunning(); } catch {}
      if (running) return sendJson(res, 200, { ok: false, needCloseEdge: true, error: '检测到 Edge 仍在运行，请完全关闭 Edge（含后台进程）后重试' });
      try {
        const r = await lib.importEdgeCookies(COOKIES, { timeoutMs: 60000 });
        if (r.ok) { await closeShared(); me = null; await refreshMe(); return sendJson(res, 200, { ok: true, imported: r.count, profile: r.profile, ...loginState() }); }
        return sendJson(res, 200, { ok: false, profile: r.profile, error: `未能从 Edge（${r.profile || '未知配置'}）读取到登录态` + (r.err ? '：' + r.err : '（该配置可能未登录抖音）') });
      } catch (e) {
        if (e.code === 'EDGE_RUNNING') return sendJson(res, 200, { ok: false, needCloseEdge: true, error: e.message });
        return sendJson(res, 200, { ok: false, error: '导入失败：' + e.message });
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/edge-status') {
      let running = false; try { running = lib.edgeRunning(); } catch {}
      return sendJson(res, 200, { ok: true, edgeRunning: running, ...loginState() });
    }
    // 用可见 Edge 登录: 打开浏览器窗口, 登录成功后自动保存登录态
    if (req.method === 'POST' && u.pathname === '/api/login') {
      if (loginJob.state === 'opening' || loginJob.state === 'waiting') {
        return sendJson(res, 200, { ok: true, ...loginJob });
      }
      loginJob = { state: 'opening', error: '', startedAt: Date.now() };
      (async () => {
        try {
          await closeShared();
          loginJob.state = 'waiting';
          const ok = await lib.openLogin(COOKIES, { channel: 'msedge', userDataDir: LOGIN_PROFILE, timeoutMs: 180000 });
          loginJob.state = ok ? 'ok' : 'timeout';
          if (!ok) loginJob.error = '未检测到登录(超时 3 分钟)';
        } catch (e) {
          // Edge 不可用时回退到内置 Chromium
          try {
            const ok = await lib.openLogin(COOKIES, { timeoutMs: 180000 });
            loginJob.state = ok ? 'ok' : 'timeout';
            if (!ok) loginJob.error = '未检测到登录(超时 3 分钟)';
          } catch (e2) { loginJob = { state: 'error', error: e2.message, startedAt: loginJob.startedAt }; }
        }
        if (loginJob.state === 'ok') { me = null; await refreshMe(); }
      })();
      return sendJson(res, 200, { ok: true, state: 'opening' });
    }
    if (req.method === 'GET' && u.pathname === '/api/login') {
      return sendJson(res, 200, { ok: true, state: loginJob.state, error: loginJob.error, ...loginState() });
    }
    // ---------- 下载编队 ----------
    if (req.method === 'GET' && u.pathname === '/api/queue') {
      return sendJson(res, 200, { ok: true, ...buildQueue() });
    }
    if (req.method === 'POST' && u.pathname === '/api/queue') {
      const body = await readBody(req);
      const action = body.action;
      const ids = (body.ids || []).map(String);
      if (action === 'add') {
        for (const id of ids) if (!queue.includes(id)) queue.push(id);
      } else if (action === 'remove') {
        const rm = new Set(ids);
        queue = queue.filter(id => !rm.has(id));
      } else if (action === 'clear') {
        queue = [];
      } else {
        return sendJson(res, 400, { ok: false, error: '未知 action' });
      }
      persistCache();
      return sendJson(res, 200, { ok: true, ...buildQueue() });
    }
    if (req.method === 'POST' && u.pathname === '/api/stop') {
      if (job.running) job.stopRequested = true;
      return sendJson(res, 200, { ok: true, running: job.running });
    }
    if (req.method === 'GET' && u.pathname === '/api/job') {
      return sendJson(res, 200, { ok: true, job });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

// 自动打开浏览器
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

loadConfig();
if (ARG.out) config.out = path.resolve(ARG.out); // CLI --out 覆盖(不改配置文件)
loadCache();

// ---------- 监听: 端口被占用时自动向后重试, 并把可用端口设为下次默认 ----------
const MAX_TRIES = 20; // 最多向后尝试的端口数
let listenPort = ARG.port || process.env.PORT || config.port || DEFAULT_PORT;
let tries = 0;
const explicitPort = !!ARG.port; // 是否由 --port 显式指定(显式则不写回默认)

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    tries++;
    if (tries < MAX_TRIES) {
      console.error(`[server] 端口 ${listenPort} 已被占用, 尝试 ${listenPort + 1} ...`);
      listenPort++;
      server.listen(listenPort);
      return;
    }
    console.error(`[server] 连续 ${MAX_TRIES} 个端口均被占用, 请关闭占用程序或用 --port <端口> 指定。`);
    process.exit(1);
  }
  console.error('[server] 启动失败:', e.message);
  process.exit(1);
});

server.on('listening', () => {
  const url = `http://localhost:${listenPort}`;
  console.log(`[server] 已启动: ${url}`);
  console.log(`[server] 输出目录: ${config.out}${ARG.out ? ' (来自 --out)' : ''}`);
  console.log(`[server] 登录态: ${loginState().loggedIn ? '已登录' : (fs.existsSync(COOKIES) ? '已导入 Cookie（未含登录）' : '匿名（未登录，用户搜索需登录）')}`);
  if (loginState().loggedIn) refreshMe(); // 后台拉取登录用户昵称/头像
  // 非显式指定且与当前默认不同 -> 把可用端口记为下次默认
  if (!explicitPort && config.port !== listenPort) {
    config.port = listenPort;
    saveConfig();
    console.log(`[server] 已将端口 ${listenPort} 写入 config.json, 下次启动默认使用。`);
  }
  if (ARG.open) openBrowser(url);
});

server.listen(listenPort);
