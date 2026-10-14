// 最小 demo：抓取指定抖音用户的全部作品元数据
// 用法: node demo.js [userUrlOrSecId] [--headless]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEFAULT_URL =
  'https://www.douyin.com/user/MS4wLjABAAAAabyOTQQVwh7Ly2rKDj9XDZCTBhYZhjFNzIeer3gVPf8NnH0BdHk5nAUPU7h1allp';

const args = process.argv.slice(2);
const headless = args.includes('--headless');
const target = args.find(a => !a.startsWith('--')) || DEFAULT_URL;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function bestGear(bitRates) {
  if (!Array.isArray(bitRates) || !bitRates.length) return null;
  const uniq = new Map();
  for (const g of bitRates) if (!uniq.has(g.gear_name)) uniq.set(g.gear_name, g);
  let best = null, bestArea = -1;
  for (const g of uniq.values()) {
    const w = g.play_addr?.width || 0, h = g.play_addr?.height || 0;
    const area = w * h;
    if (area > bestArea) { bestArea = area; best = { gear_name: g.gear_name, w, h, url: g.play_addr?.url_list?.[0] }; }
  }
  return best;
}

function classify(a) {
  const imgs = a.images || [];
  if (imgs.length) {
    const vids = imgs.filter(i => i.video).length;
    return vids ? `图文(混合 ${imgs.length}段, 含视频${vids})` : `图文(图片 ${imgs.length}张)`;
  }
  return '视频';
}

(async () => {
  const storageState = path.join(__dirname, 'cookies.json');
  const useState = fs.existsSync(storageState);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: UA,
    storageState: useState ? storageState : undefined,
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  const works = new Map(); // aweme_id -> aweme
  let lastHasMore = null;

  page.on('response', async (resp) => {
    const url = resp.url();
    if (!url.includes('/aweme/v1/web/aweme/post/')) return;
    try {
      const data = await resp.json();
      lastHasMore = data.has_more;
      for (const a of data.aweme_list || []) works.set(a.aweme_id, a);
    } catch { /* ignore */ }
  });

  console.log(`[demo] 打开: ${target}  (${useState ? '已加载 cookies.json' : '匿名'}, ${headless ? 'headless' : '有头'})`);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[demo] 已加载页面, title=${await page.title()}`);

  // 等待首个 aweme/post 响应
  for (let i = 0; i < 40 && works.size === 0; i++) await page.waitForTimeout(500);

  // 自动滚动加载更多
  let stagnant = 0;
  for (let i = 0; i < 60; i++) {
    const before = works.size;
    await page.mouse.move(700, 500);
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(1200);
    if (works.size === before) {
      stagnant++;
      if (stagnant >= 4) break;
    } else stagnant = 0;
    if (lastHasMore === 0) break;
  }

  const list = [...works.values()];
  console.log(`\n[demo] 抓到 ${list.length} 个作品 (last has_more=${lastHasMore})`);
  console.log('----');
  for (const a of list) {
    const t = classify(a);
    let extra = '';
    if (a.images?.length) {
      extra = a.images.map(i => (i.video ? 'V' : 'I')).join('');
    } else {
      const g = bestGear(a.video?.bit_rate);
      extra = g ? `${g.gear_name} ${g.w}x${g.h}` : 'n/a';
    }
    console.log(`${a.aweme_id}  [${t}]  ${extra}  ${(a.desc || '').slice(0, 30)}`);
  }

  fs.writeFileSync(path.join(__dirname, 'demo_out.json'), JSON.stringify(list, null, 2));
  console.log(`\n[demo] 原始数据已写入 demo_out.json`);

  await browser.close();
})().catch(err => {
  console.error('[demo] 出错:', err);
  process.exit(1);
});
