// 抖音下载 公共核心库：CLI(dl.js) 与 本地服务(server.js) 共用
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_URL =
  'https://www.douyin.com/user/MS4wLjABAAAAabyOTQQVwh7Ly2rKDj9XDZCTBhYZhjFNzIeer3gVPf8NnH0BdHk5nAUPU7h1allp';

// ---------- 工具 ----------
function sanitize(s, max = 80) {
  let t = String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/[. ]+$/, '');
  if (t.length > max) t = t.slice(0, max).trim();
  return t || 'untitled';
}

// 从 bit_rate 选档: target=0 取最高分辨率; 否则取不超过 target 的最大; 都没有则取最低
function pickGear(bitRates, target) {
  if (!Array.isArray(bitRates) || !bitRates.length) return null;
  const uniq = new Map();
  for (const g of bitRates) if (!uniq.has(g.gear_name)) uniq.set(g.gear_name, g);
  const list = [...uniq.values()].filter(g => g.play_addr && g.play_addr.url_list && g.play_addr.url_list.length)
    .map(g => ({ g, w: g.play_addr.width || 0, h: g.play_addr.height || 0, url: g.play_addr.url_list[0] }));
  if (!list.length) return null;
  if (!target) return list.sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const under = list.filter(x => x.h <= target).sort((a, b) => b.h - a.h);
  if (under.length) return under[0];
  return list.sort((a, b) => a.h - b.h)[0];
}

// 图片取不带水印的 jpeg 优先, 否则 webp
function pickImage(item) {
  const list = item.url_list || [];
  const jpeg = list.find(u => /\.jpeg/i.test(u.split('?')[0]));
  const webp = list.find(u => /\.webp/i.test(u.split('?')[0]));
  const url = jpeg || webp || list[0];
  const ext = /\.jpeg/i.test((url || '').split('?')[0]) ? '.jpeg' : '.webp';
  return url ? { url, ext } : null;
}

// 把一个作品解析成待下载条目 [{kind,no,url,ext}]
function planWork(a, quality, wantBgm) {
  const items = [];
  const imgs = a.images || [];
  if (imgs.length) {
    imgs.forEach((it, idx) => {
      const no = String(idx + 1).padStart(2, '0');
      if (it.video) {
        const gear = pickGear(it.video.bit_rate, quality) || { url: it.video.play_addr.url_list[0] };
        items.push({ kind: 'video', no, url: gear.url, ext: '.mp4' });
      } else {
        const im = pickImage(it);
        if (im) items.push({ kind: 'image', no, url: im.url, ext: im.ext });
      }
    });
  } else if (a.video) {
    const gear = pickGear(a.video.bit_rate, quality) || { url: a.video.play_addr.url_list[0] };
    items.push({ kind: 'video', no: null, url: gear.url, ext: '.mp4' });
  }
  const bgmUrl = a.music && a.music.play_url && a.music.play_url.url_list && a.music.play_url.url_list[0];
  if (wantBgm && bgmUrl) {
    items.push({ kind: 'audio', no: null, url: bgmUrl, ext: '.mp3' });
  }
  return items;
}

// 作品文件名前缀: 作者_文案(含标签)
function workBase(a) {
  const author = (a.author && a.author.nickname) || 'unknown';
  return `${sanitize(author, 24)}_${sanitize(a.desc, 60)}`;
}

// 单个下载条目对应的文件名
function fileNameFor(base, it) {
  const stem = it.kind === 'audio' ? `${base}_bgm` : it.no ? `${base}_${it.no}` : base;
  return stem + it.ext;
}

// 图文作品"合成视频"的文件名
function mergedName(base) {
  return `${base}_合成.mp4`;
}

// 作品形态: video=纯视频, images=纯图片, mixed=图文混合
function workType(a) {
  const imgs = a.images || [];
  if (!imgs.length) return a.video ? 'video' : 'unknown';
  return imgs.some(i => i.video) ? 'mixed' : 'images';
}

// 作品摘要(用于列表展示)
function summarize(a) {
  const imgs = a.images || [];
  const type = workType(a);
  const mediaCount = imgs.length || (a.video ? 1 : 0);
  const cover =
    (a.video && a.video.cover && a.video.cover.url_list && a.video.cover.url_list[0]) ||
    (imgs[0] && imgs[0].url_list && imgs[0].url_list[0]) ||
    null;
  return {
    id: String(a.aweme_id),
    desc: a.desc || '',
    type,
    mediaCount,
    createTime: a.create_time,
    date: a.create_time ? new Date(a.create_time * 1000).toISOString().slice(0, 10) : '',
    cover,
    author: { nickname: (a.author && a.author.nickname) || '', secUid: (a.author && a.author.sec_uid) || '' },
  };
}

// 本地存储情况: 依据 out 目录比对"应有文件 vs 实有文件"
function localStatus(a, opts) {
  const author = (a.author && a.author.nickname) || 'unknown';
  const base = workBase(a);
  const dir = path.join(opts.out, sanitize(author, 40));
  const items = planWork(a, opts.quality, opts.bgm);
  let have = 0;
  for (const it of items) {
    const f = path.join(dir, fileNameFor(base, it));
    if (fs.existsSync(f) && fs.statSync(f).size > 0) have++;
  }
  const expected = items.length;
  const mergedPath = path.join(dir, mergedName(base));
  const merged = fs.existsSync(mergedPath) && fs.statSync(mergedPath).size > 0;
  let status = 'missing'; // 未下载
  if (merged) { status = 'done'; if (have < expected) have = expected; } // 已合成(散件可能已清理)
  else if (expected && have === expected) status = 'done'; // 已完成
  else if (have > 0) status = 'partial'; // 部分缺失
  return { status, have, expected, merged };
}

// 作品按时间排序(默认旧→新)
function sortWorks(list, order) {
  const timeOf = a => a.create_time || Number(BigInt(a.aweme_id) >> 32n);
  const dir = order === 'new' ? -1 : 1;
  return [...list].sort((a, b) => (timeOf(a) - timeOf(b)) * dir);
}

// ---------- 链接识别 ----------
// 返回 {kind:'user',secUid,url} | {kind:'video',awemeId} | {kind:'short',url} | null
function classify(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{15,}$/.test(s)) return { kind: 'video', awemeId: s };
  if (/^MS4wLjAB/.test(s)) return { kind: 'user', secUid: s, url: 'https://www.douyin.com/user/' + s };
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.hostname.includes('v.douyin.com')) return { kind: 'short', url: s };
  let m = u.pathname.match(/\/user\/([^/]+)/);
  if (m) return { kind: 'user', secUid: m[1], url: s };
  m = u.pathname.match(/\/(?:video|note)\/(\d+)/);
  if (m) return { kind: 'video', awemeId: m[1], url: s };
  const mid = u.searchParams.get('modal_id');
  if (mid) return { kind: 'video', awemeId: mid, url: s };
  return null;
}

// 跟随短链重定向后再识别
async function resolveInput(page, input) {
  let c = classify(input);
  if (!c) return null;
  if (c.kind === 'short') {
    await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    const finalUrl = page.url();
    c = classify(finalUrl);
    if (!c) return null;
    c.url = finalUrl;
  }
  if (c.kind === 'user' && !c.url) c.url = 'https://www.douyin.com/user/' + c.secUid;
  return c;
}

// ---------- 采集 ----------
// 用户全部作品(监听 aweme/post 分页接口, 滚动加载)
async function collectWorks(page, target) {
  const works = new Map();
  let lastHasMore = null;
  const handler = async (resp) => {
    if (!resp.url().includes('/aweme/v1/web/aweme/post/')) return;
    try {
      const data = await resp.json();
      lastHasMore = data.has_more;
      for (const a of data.aweme_list || []) works.set(a.aweme_id, a);
    } catch { /* ignore */ }
  };
  page.on('response', handler);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 40 && works.size === 0; i++) await page.waitForTimeout(500);
  let stagnant = 0;
  for (let i = 0; i < 200; i++) {
    const before = works.size;
    await page.mouse.move(700, 500);
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(1000);
    stagnant = works.size === before ? stagnant + 1 : 0;
    if (stagnant >= 4 || lastHasMore === 0) break;
  }
  page.off('response', handler);
  return works;
}

// 单个作品详情(监听 aweme/detail)
async function collectOne(page, awemeId) {
  const url = 'https://www.douyin.com/video/' + awemeId;
  let found = null;
  const handler = async (resp) => {
    if (!resp.url().includes('/aweme/v1/web/aweme/detail/')) return;
    try {
      const data = await resp.json();
      const a = data.aweme_detail || (data.aweme_details && data.aweme_details[0]);
      if (a) found = a;
    } catch { /* ignore */ }
  };
  page.on('response', handler);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 30 && !found; i++) await page.waitForTimeout(500);
  page.off('response', handler);
  return found;
}

// 关键词搜索用户(需登录态), 返回仿官方搜索页所需字段
// 注意: 直接导航 /search/xxx?type=user 会被反爬拦截到"验证码中间页";
//       必须先在主页预热, 再通过页内搜索框做客户端导航, 才能拿到真实的用户搜索接口数据。
async function searchUsers(page, keyword, opts = {}) {
  const mode = opts.mode === 'id' ? 'id' : 'name';
  const users = new Map();
  const pickAvatar = (u) => {
    for (const k of ['avatar_thumb', 'avatar_168x168', 'avatar_larger', 'avatar_medium', 'avatar_300x300']) {
      const a = u[k];
      if (a && a.url_list && a.url_list[0]) return a.url_list[0];
    }
    return '';
  };
  const push = (u) => {
    const uid = u && (u.sec_uid || u.secUid);
    if (!uid || uid === 'self') return; // 过滤"我的"等非搜索结果
    const prev = users.get(uid) || {};
    users.set(uid, {
      secUid: uid,
      nickname: u.nickname || prev.nickname || '',
      avatar: pickAvatar(u) || prev.avatar || '',
      signature: u.signature || prev.signature || '',
      uniqueId: u.unique_id || u.short_id || prev.uniqueId || '',
      followerCount: u.follower_count || prev.followerCount || 0,
      followerText: u.follower_count_str || prev.followerText || '',
      verify: u.custom_verify || u.enterprise_verify_reason || u.versatile_display || prev.verify || '',
      totalFavorited: u.total_favorited || prev.totalFavorited || 0,
    });
  };
  // 解析搜索接口响应体: general/search/stream 是 chunked 传输(带十六进制长度行), 需先剥掉
  const parseSearchBody = (txt) => {
    if (!txt) return null;
    let s = txt.replace(/^[0-9a-fA-F]+\r?\n/, '');
    const i = s.indexOf('{');
    if (i < 0) return null;
    s = s.slice(i);
    try { return JSON.parse(s); } catch {
      const j = s.lastIndexOf('}');
      if (j > 0) { try { return JSON.parse(s.slice(0, j + 1)); } catch { /* ignore */ } }
      return null;
    }
  };
  // 从搜索结果里收集用户(统一取 user_list 里的 user_info, 避免把视频作者误当用户)
  const collectUsers = (j) => {
    const seen = new WeakSet();
    const walk = (v) => {
      if (!v || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v.user_list)) for (const it of v.user_list) push((it && it.user_info) || it);
      for (const k of Object.keys(v)) { const c = v[k]; if (c && typeof c === 'object') walk(c); }
    };
    walk(j);
  };
  // 只认搜索接口, 避免把推荐流里的作者误当搜索结果
  const onResp = async (resp) => {
    const u = resp.url();
    if (!/\/aweme\/v1\/web\/(?:general|discover)\/search\//.test(u) && !/\/aweme\/v1\/web\/search\/user\//.test(u)) return;
    try { collectUsers(parseSearchBody(await resp.text())); } catch { /* ignore */ }
  };
  // 兜底: 从结果卡片 DOM 提取(接口未命中时)
  const grabDom = async () => {
    const cards = await page.$$eval('[data-e2e*="user"] a[href*="/user/"], a[href*="/user/"]', (els) =>
      els.map((e) => {
        const img = e.querySelector('img');
        return {
          href: e.getAttribute('href') || '',
          avatar: (img && img.getAttribute('src')) || '',
          text: (e.innerText || '').replace(/\s+/g, '\n'),
        };
      })).catch(() => []);
    for (const c of cards) {
      const m = c.href.match(/\/user\/([^/?#]+)/);
      if (!m || m[1] === 'self' || users.has(m[1])) continue;
      const lines = (c.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
      push({ sec_uid: m[1], nickname: lines[0] || '', avatar_thumb: c.avatar ? { url_list: [c.avatar] } : null });
    }
  };
  page.on('response', onResp);
  try {
    // 搜索框回车依赖"窗口焦点": headless 下输入/回车会被前端忽略, 需让页面处于前台
    await page.bringToFront().catch(() => {});
    // 1) 预热主页(带登录态下发新鲜的 ttwid/msToken 等反爬凭据)
    try { await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch { /* ignore */ }
    await page.waitForTimeout(6000);
    // 2) 页内搜索框输入并回车(客户端导航, 规避验证码中间页)
    const box = await page.$('input[data-e2e="searchbar-input"]');
    if (box) {
      await box.click().catch(() => {});
      await box.fill('').catch(() => {});
      await box.type(keyword, { delay: 90 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.keyboard.press('Enter').catch(() => {});
      for (let i = 0; i < 20 && !/\/jingxuan\/search\//.test(page.url()); i++) await page.waitForTimeout(500);
      await page.waitForTimeout(2500);
    }
    // 3) 切到"用户"标签页, 触发 discover/search 接口
    await page.evaluate(() => {
      const t = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /^用户$/.test((e.textContent || '').trim()));
      if (t.length) t[0].click();
    }).catch(() => {});
    for (let i = 0; i < 24 && users.size === 0; i++) { await page.waitForTimeout(500); await grabDom(); }
    // 4) 滚动加载更多
    for (let i = 0; i < 2; i++) { await page.mouse.move(700, 500); await page.mouse.wheel(0, 2000); await page.waitForTimeout(1500); await grabDom(); }
  } finally {
    page.off('response', onResp);
  }
  let list = [...users.values()];
  // 按抖音号搜索: 优先精确匹配 unique_id, 其次包含匹配; 都不匹配则视为未找到(不返回无关用户)
  if (mode === 'id') {
    const want = (keyword || '').trim().toLowerCase();
    const exact = list.filter((u) => (u.uniqueId || '').toLowerCase() === want);
    const partial = list.filter((u) => (u.uniqueId || '').toLowerCase().includes(want));
    list = exact.length ? exact : partial;
  }
  return list.map((u) => ({ ...u, nickname: u.nickname || '（未获取昵称）' }));
}

// ---------- 浏览器 ----------
// 启动并返回 {browser, context}; cookies 存在则加载登录态
// opts: { headless, cookies, channel }  channel 可传 'msedge' 使用真实 Edge
async function launch(opts = {}) {
  const browser = await chromium.launch({
    headless: !!opts.headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    ...(opts.channel ? { channel: opts.channel } : {}),
  });
  const useState = opts.cookies && fs.existsSync(opts.cookies);
  const context = await browser.newContext({
    userAgent: UA,
    storageState: useState ? opts.cookies : undefined,
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });
  // 隐藏自动化特征, 避免抖音判定为爬虫而只返回页面外壳
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return { browser, context };
}

// 获取当前登录用户资料(昵称/头像/唯一号); 需已加载登录态, 未登录返回 null
async function getSelfProfile(page) {
  let user = null;
  const handler = async (resp) => {
    if (!/\/aweme\/v1\/web\/user\/profile\/self\//.test(resp.url())) return;
    try {
      const j = await resp.json();
      if (j && j.status_code === 0 && j.user) user = j.user;
    } catch { /* ignore */ }
  };
  page.on('response', handler);
  try {
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 24 && !user; i++) await page.waitForTimeout(500);
  } catch { /* ignore */ } finally {
    page.off('response', handler);
  }
  if (!user) return null;
  const av = (k) => (user[k] && user[k].url_list && user[k].url_list[0]) || '';
  return {
    nickname: user.nickname || '',
    secUid: user.sec_uid || '',
    uniqueId: user.unique_id || '',
    avatar: av('avatar_thumb') || av('avatar_168x168') || av('avatar_larger') || '',
  };
}

// 解析导入的 Cookie -> Playwright storageState
// 支持三种格式: storageState JSON / 浏览器扩展导出的 cookie 数组 / 原始 Cookie 字符串("a=b; c=d")
function parseCookies(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('内容为空');
  let obj = null;
  try { obj = JSON.parse(text); } catch { obj = null; }
  const norm = (arr) => ({
    cookies: arr.map((c) => ({
      name: String(c.name || ''),
      value: String(c.value || ''),
      domain: c.domain || '.douyin.com',
      path: c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires
        : (typeof c.expirationDate === 'number' ? Math.floor(c.expirationDate) : -1),
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
      sameSite: /none|no_restriction/i.test(String(c.sameSite || '')) ? 'None'
        : (/strict/i.test(String(c.sameSite || '')) ? 'Strict' : 'Lax'),
    })).filter((c) => c.name),
    origins: [],
  });
  if (obj) {
    if (Array.isArray(obj)) return norm(obj);
    if (Array.isArray(obj.cookies)) return { cookies: obj.cookies, origins: obj.origins || [] };
    throw new Error('JSON 中未找到 cookies 字段');
  }
  // 原始 Cookie 字符串
  const arr = text.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    if (i < 0) return null;
    return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: '.douyin.com', path: '/' };
  }).filter(Boolean);
  if (!arr.length) throw new Error('无法解析 cookie 内容');
  return norm(arr);
}

// 打开可见浏览器供用户登录抖音; 登录成功后把登录态保存到 savePath
// opts: { channel('msedge'|undefined), userDataDir, timeoutMs }
async function openLogin(savePath, opts = {}) {
  const args = ['--disable-blink-features=AutomationControlled'];
  const base = { headless: false, args, viewport: { width: 1200, height: 820 } };
  if (opts.channel) base.channel = opts.channel;
  let context, browser = null;
  if (opts.userDataDir) {
    fs.mkdirSync(opts.userDataDir, { recursive: true });
    context = await chromium.launchPersistentContext(opts.userDataDir, base);
  } else {
    browser = await chromium.launch(base);
    context = await browser.newContext({ viewport: base.viewport });
  }
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  const deadline = Date.now() + (opts.timeoutMs || 180000);
  let ok = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    try {
      const cookies = await context.cookies('https://www.douyin.com');
      if (cookies.some((c) => /sessionid/i.test(c.name) && c.value)) { ok = true; break; }
    } catch { /* ignore */ }
  }
  try { await context.storageState({ path: savePath }); } catch { /* ignore */ }
  try { await context.close(); } catch { /* ignore */ }
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  return ok;
}

// ---------- 从系统 Edge 自动导入登录态 ----------
// Edge 使用 App-Bound 加密, 外部无法解密; 但让 Edge 自己打开该配置文件即可原生解密,
// 因此这里用 Playwright 以 --profile-directory 启动系统 Edge(需 Edge 已完全关闭), 读出 Cookie 后关闭。
function edgeUserDataDir() {
  const base = process.env.LOCALAPPDATA || process.env.USERPROFILE || '';
  return path.join(base, 'Microsoft', 'Edge', 'User Data');
}
// 判断某配置文件的 Cookie 库是否被占用(被占用=Edge 正在运行该配置)
function edgeProfileLocked(dirName) {
  const ck = path.join(edgeUserDataDir(), dirName, 'Network', 'Cookies');
  try { const fd = fs.openSync(ck, 'r+'); fs.closeSync(fd); return false; }
  catch { return true; }
}
// Edge 是否在运行: tasklist(可能受限) 或 任一配置文件被锁, 任一命中即视为运行
function edgeRunning() {
  try {
    const out = execSync('tasklist /NH /FI "IMAGENAME eq msedge.exe"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (/msedge\.exe/i.test(out)) return true;
  } catch { /* ignore */ }
  for (const p of edgeProfiles()) { if (edgeProfileLocked(p.dir)) return true; }
  return false;
}
// 列出含 Cookies 的 Edge 配置文件, 按 Cookies 修改时间倒序(最近使用的最可能已登录)
function edgeProfiles() {
  const ud = edgeUserDataDir();
  const res = [];
  try {
    for (const d of fs.readdirSync(ud, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      if (d.name !== 'Default' && !/^Profile \d+$/.test(d.name)) continue;
      const ck = path.join(ud, d.name, 'Network', 'Cookies');
      if (!fs.existsSync(ck)) continue;
      let mtime = 0; try { mtime = fs.statSync(ck).mtimeMs; } catch { /* ignore */ }
      res.push({ dir: d.name, mtime });
    }
  } catch { /* ignore */ }
  return res.sort((a, b) => b.mtime - a.mtime);
}
// 一次性从 Edge 导入登录态到 savePath; 需要 Edge 完全关闭
async function importEdgeCookies(savePath, opts = {}) {
  const ud = edgeUserDataDir();
  if (!fs.existsSync(ud)) throw new Error('未找到 Edge 用户数据目录');
  if (edgeRunning()) { const e = new Error('请先完全关闭 Edge 后重试'); e.code = 'EDGE_RUNNING'; throw e; }
  const profiles = edgeProfiles();
  if (!profiles.length) throw new Error('未找到可用的 Edge 配置文件');
  let last = { count: 0, loggedIn: false, profile: profiles[0].dir };
  const budget = opts.timeoutMs || 60000;
  for (const p of profiles) {
    try {
      const ctx = await chromium.launchPersistentContext(ud, {
        channel: 'msedge',
        headless: true,
        args: ['--profile-directory=' + p.dir, '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
        viewport: { width: 1280, height: 800 },
      });
      try {
        await Promise.race([
          (async () => {
            const got = await ctx.cookies('https://www.douyin.com');
            const map = new Map();
            for (const c of got) map.set(c.name, c);
            const cookies = [...map.values()].filter((c) => /douyin|toutiao|bytedance/i.test(c.domain || '') || !c.domain);
            const loggedIn = cookies.some((c) => /^sessionid$/i.test(c.name) && c.value);
            if (loggedIn) {
              fs.writeFileSync(savePath, JSON.stringify({ cookies, origins: [] }), 'utf8');
              last = { ok: true, count: cookies.length, loggedIn: true, profile: p.dir };
            } else {
              last = { ok: false, count: cookies.length, loggedIn: false, profile: p.dir };
            }
          })(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('读取超时')), budget)),
        ]);
      } finally {
        try { await ctx.close(); } catch { /* ignore */ }
      }
      if (last.ok) return last;
    } catch (e) {
      last = { ok: false, count: 0, loggedIn: false, profile: p.dir, err: e.message };
    }
  }
  return last;
}

module.exports = {
  UA, DEFAULT_URL,
  sanitize, pickGear, pickImage, planWork, workBase, fileNameFor, mergedName, workType,
  summarize, localStatus, sortWorks,
  classify, resolveInput, collectWorks, collectOne, searchUsers, launch, getSelfProfile,
  parseCookies, openLogin, importEdgeCookies, edgeRunning,
};
