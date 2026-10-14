// 抖音作品下载 CLI
// 用法:
//   node dl.js <userUrlOrSecId> [options]
// options:
//   --out <dir>        输出目录 (默认 downloads)
//   --quality <N>      目标清晰度高度, 如 720 (默认不填=取最高)
//   --works <id,id>    只下载指定作品 aweme_id (默认全部)
//   --cookies <file>   登录态 storageState json (默认 ./cookies.json, 存在才用)
//   --headless         无头模式 (默认有头)
//   --no-bgm           不下载背景音乐
//   --sort <old|new>   下载顺序: old=从旧到新(默认), new=从新到旧
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const opts = {
  headless: false, out: 'downloads', works: null, quality: 0,
  cookies: path.join(__dirname, 'cookies.json'), bgm: true, sort: 'old',
};
const positional = [];
let wantHelp = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') wantHelp = true;
  else if (a === '--headless') opts.headless = true;
  else if (a === '--headed') opts.headless = false;
  else if (a === '--out') opts.out = argv[++i];
  else if (a === '--quality') opts.quality = parseInt(argv[++i], 10) || 0;
  else if (a === '--works') opts.works = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
  else if (a === '--cookies') opts.cookies = argv[++i];
  else if (a === '--no-bgm') opts.bgm = false;
  else if (a === '--sort') opts.sort = (argv[++i] === 'new' ? 'new' : 'old');
  else positional.push(a);
}

const USAGE = `抖音作品下载 CLI

用法:
  node dl.js <用户链接或sec_uid> [选项]

选项:
  --out <目录>        输出目录 (默认 downloads)
  --quality <N>       目标清晰度高度, 如 720 (默认取最高)
  --works <id,id>     只下载指定作品 aweme_id (默认全部)
  --sort <old|new>    下载顺序 old=从旧到新(默认) / new=从新到旧
  --cookies <file>    登录态 storageState json (默认 ./cookies.json, 存在才用)
  --headless          无头模式 (默认有头)
  --no-bgm            不下载背景音乐
  -h, --help          显示本帮助

示例:
  node dl.js https://www.douyin.com/user/xxxx
  node dl.js https://www.douyin.com/user/xxxx --sort new --headless
`;

if (wantHelp || positional.length === 0) { console.log(USAGE); process.exit(0); }
const userUrl = positional[0];

// ---------- 主流程 ----------
(async () => {
  const { browser, context } = await lib.launch(opts);
  const page = await context.newPage();

  console.log(`[dl] 目标: ${userUrl} (${fs.existsSync(opts.cookies) ? '已加载登录态' : '匿名'}, ${opts.headless ? 'headless' : '有头'})`);

  let works;
  try {
    works = await lib.collectWorks(page, userUrl);
  } catch (e) {
    console.error('[dl] 打开页面失败:', e.message);
    await browser.close();
    process.exit(1);
  }

  let list = [...works.values()];
  if (opts.works) list = list.filter(a => opts.works.includes(String(a.aweme_id)));
  list = lib.sortWorks(list, opts.sort);
  console.log(`[dl] 抓到 ${works.size} 个作品, 待处理 ${list.length} 个 (顺序: ${opts.sort === 'new' ? '新→旧' : '旧→新'})\n`);

  let okCount = 0, skipCount = 0, failCount = 0;
  for (const a of list) {
    const author = (a.author && a.author.nickname) || 'unknown';
    const base = lib.workBase(a);
    const dir = path.join(opts.out, lib.sanitize(author, 40));
    fs.mkdirSync(dir, { recursive: true });
    const items = lib.planWork(a, opts.quality, opts.bgm);
    console.log(`[作品 ${a.aweme_id}] ${base}  ->  ${items.length} 个文件`);

    for (const it of items) {
      const fname = lib.fileNameFor(base, it);
      const fpath = path.join(dir, fname);
      if (fs.existsSync(fpath) && fs.statSync(fpath).size > 0) { skipCount++; continue; }
      try {
        const resp = await context.request.get(it.url, { headers: { referer: 'https://www.douyin.com/' }, timeout: 120000 });
        if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
        fs.writeFileSync(fpath, await resp.body());
        const kb = (fs.statSync(fpath).size / 1024).toFixed(0);
        console.log(`   ✓ ${it.kind.padEnd(5)} ${fname} (${kb} KB)`);
        okCount++;
      } catch (e) {
        console.log(`   ✗ ${it.kind} ${fname} 失败: ${e.message}`);
        failCount++;
      }
    }
  }

  console.log(`\n[dl] 完成: 成功 ${okCount}, 跳过 ${skipCount}, 失败 ${failCount}`);
  console.log(`[dl] 输出目录: ${path.resolve(opts.out)}`);
  await browser.close();
})().catch(e => { console.error('[dl] 异常:', e); process.exit(1); });
