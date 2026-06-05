#!/usr/bin/env node
// MT Farmer Standalone – private tracker torrent farmer (Puppeteer)
// Checkpoint/log files default to $HOME, so progress survives restarts.
//
// 安装: npm install
// 运行: npm start

const HOME = require('os').homedir();
const CONFIG = {
  trUrl:  process.env.TR_URL  || '',
  trUser: process.env.TR_USER || '',
  trPass: process.env.TR_PASS || '',
  browseUrls: (process.env.BROWSE_URL_LIST || process.env.BROWSE_URL || process.env.MT_BROWSE_LIST || process.env.MT_BROWSE || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean),
  dryRun: process.env.DRY_RUN !== 'false',
  downloadsEnabled: process.env.DOWNLOADS_ENABLED === 'true',
  ackSiteRules: process.env.ACK_SITE_RULES === 'true',
  dlDir: process.env.DL_DIR || '/tmp/mt_downloads',
  logFile: process.env.LOG_FILE || require('path').join(HOME, '.mt_farmer.log'),
  checkpointFile: process.env.CHECKPOINT_FILE || require('path').join(HOME, '.mt_farmer_checkpoint.json'),
  maxBytes: parseInt(process.env.MAX_BYTES || '1099511627776', 10),
  segmentMaxTorrentBytes: parseInt(process.env.SEGMENT_MAX_TORRENT_BYTES || '367001600', 10),
  segmentMinTorrentBytes: parseInt(process.env.SEGMENT_MIN_TORRENT_BYTES || '0', 10),
  dailyLimit: parseInt(process.env.DAILY_LIMIT || '1200', 10),
  hourlyLimit: parseInt(process.env.HOURLY_LIMIT || '90', 10),
  // Timezone offset used for daily quota windows.
  tzOffset: parseInt(process.env.TZ_OFFSET || '8', 10),
  chromeDataDir: process.env.CHROME_DATA_DIR || '',
  headless: process.env.HEADLESS !== 'false',
  pageLoadWait:  parseInt(process.env.PAGE_LOAD_WAIT  || '10000'),
  downloadWait:  parseInt(process.env.DOWNLOAD_WAIT   || '12000'),
  betweenTorrent:parseInt(process.env.BETWEEN_TORRENT || '45000'),
  maxPages: parseInt(process.env.MAX_PAGES || '100'),
};

const fs = require('fs'), path = require('path');
const TR_URL  = CONFIG.trUrl;
const TR_AUTH = 'Basic ' + Buffer.from(CONFIG.trUser + ':' + CONFIG.trPass).toString('base64');
const DL_DIR  = CONFIG.dlDir;
const LOG_FILE = CONFIG.logFile;
const CKPT = CONFIG.checkpointFile;
let trSid = null;

// ── 日志 + 自动 rotate ──────────────────────────────────────────────────
let logLineCount = 0;
function rotateLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const lines = fs.readFileSync(LOG_FILE,'utf8').split('\n').length;
    if (lines < 5000) { logLineCount = lines; return; }
    try { fs.unlinkSync(LOG_FILE + '.2'); } catch(_) {}
    try { fs.renameSync(LOG_FILE + '.1', LOG_FILE + '.2'); } catch(_) {}
    try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch(_) {}
    fs.writeFileSync(LOG_FILE, '');
    logLineCount = 0;
  } catch(_) {}
}
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = ts + ' ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
  logLineCount++;
  if (logLineCount >= 5000) rotateLog();
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pageUrl(base, page) {
  try { const u = new URL(base); u.searchParams.set('pageNumber', String(page)); return u.toString(); }
  catch (_) { return base + (base.includes('?') ? '&' : '?') + 'pageNumber=' + page; }
}

// 🕐 获取指定时区的日期字符串 YYYY-MM-DD
function tzDate(offsetHours) { const d = new Date(Date.now() + offsetHours * 3600000); return d.toISOString().slice(0, 10); }

// ── Checkpoint（原子写入 + 持久化小时计数）──────────────────────────────
function loadCkpt() { try { return JSON.parse(fs.readFileSync(CKPT, 'utf8')); } catch (_) { return null; } }
// 🔒 统一更新 globals + 原子写 checkpoint（所有分支都必须通过此函数持久化）
function persistProgress(page, row, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow, segment = currentSegment) {
  currentSegment = segment; currentPage = page; currentRow = row; globalAdded = added; globalAddedSize = addedSize;
  globalDlToday = dlToday; globalDailyDate = dailyDate; globalHourlyCount = hourlyCount; globalHourlyWindow = hourlyWindow;
  try {
    fs.writeFileSync(CKPT + '.tmp', JSON.stringify({ segment, page, row, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow, time: new Date().toISOString() }));
    fs.renameSync(CKPT + '.tmp', CKPT);
  } catch (_) {}
}

// ── Transmission RPC ──────────────────────────────────────────────────────
async function trRpc(method, args = {}, retry = true) {
  if (!trSid) {
    const r = await fetch(TR_URL, { headers: { Authorization: TR_AUTH }, signal: AbortSignal.timeout(10000) });
    trSid = r.headers.get('X-Transmission-Session-Id') || '';
  }
  const r = await fetch(TR_URL, {
    method: 'POST',
    headers: { Authorization: TR_AUTH, 'X-Transmission-Session-Id': trSid, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, arguments: args }),
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 409 && retry) {
    const nsid = r.headers.get('X-Transmission-Session-Id');
    if (nsid) { trSid = nsid; return trRpc(method, args, false); }
  }
  const j = await r.json();
  if (j.result !== 'success') {
    if (j.result && j.result.includes('duplicate')) { log(' ⏭️ 重复种子, 跳过'); return null; }
    throw new Error(j.result);
  }
  // TR 4.x returns torrent-duplicate for existing torrents with result=success
  if (j.arguments && j.arguments['torrent-duplicate']) { log(' ⏭️ 重复种子, 跳过'); return null; }
  return j.arguments;
}

// 🧮 扩展单位解析：支持 KB/MB/GB/TB + KiB/MiB/GiB/TiB + 逗号分隔
function parseSize(text) {
  if (!text) return 0;
  const m = text.toUpperCase().match(/([\d.,]+)\s*(KIB|MIB|GIB|TIB|KB|MB|GB|TB|B)/);
  if (!m) return 0;
  const v = parseFloat(m[1].replace(/,/g, ''));
  const u = m[2];
  if (u === 'KIB' || u === 'KB') return Math.round(v * 1024);
  if (u === 'MIB' || u === 'MB') return Math.round(v * 1048576);
  if (u === 'GIB' || u === 'GB') return Math.round(v * 1073741824);
  if (u === 'TIB' || u === 'TB') return Math.round(v * 1099511627776);
  return Math.round(v);
}

// ── 主流程 ────────────────────────────────────────────────────────────────
let currentSegment = 0, currentPage = 1, currentRow = 0, globalAdded = 0, globalAddedSize = 0;
let globalDlToday = 0, globalDailyDate = '', globalHourlyCount = 0, globalHourlyWindow = 0;
let browserRef = null;

// 🔴 SIGINT / SIGTERM 保护
process.on('SIGINT', async () => {
  persistProgress(currentPage, currentRow, globalAdded, globalAddedSize, globalDlToday, globalDailyDate, globalHourlyCount, globalHourlyWindow);
  log('\n⚠️ SIGINT 已保存断点，安全退出');
  if (browserRef) try { await browserRef.close(); } catch (_) {}
  process.exit(0);
});
process.on('SIGTERM', async () => {
  persistProgress(currentPage, currentRow, globalAdded, globalAddedSize, globalDlToday, globalDailyDate, globalHourlyCount, globalHourlyWindow);
  log('\n⚠️ SIGTERM 已保存断点，安全退出');
  if (browserRef) try { await browserRef.close(); } catch (_) {}
  process.exit(0);
});

async function main() {
  if (CONFIG.browseUrls.length === 0) {
    throw new Error('Please set BROWSE_URL or BROWSE_URL_LIST before running');
  }
  if (!CONFIG.dryRun && (!CONFIG.downloadsEnabled || !CONFIG.ackSiteRules)) {
    throw new Error('Active downloading requires DRY_RUN=false DOWNLOADS_ENABLED=true ACK_SITE_RULES=true');
  }
  if (!CONFIG.dryRun && (!CONFIG.trUrl || !CONFIG.trUser || !CONFIG.trPass)) {
    throw new Error('Active downloading requires TR_URL TR_USER TR_PASS');
  }

  try { fs.mkdirSync(DL_DIR, { recursive: true }); } catch (_) {}
  rotateLog();

  const ckpt = loadCkpt();
  let added = 0, addedSize = 0, startSegment = 0, startPage = 1, startRow = 0;

  // Daily/hourly download counters. Keep conservative defaults.
  const today = tzDate(CONFIG.tzOffset);
  let dlToday = 0, dailyDate = today;
  const DAILY_LIMIT = CONFIG.dailyLimit;
  const HOURLY_LIMIT = CONFIG.hourlyLimit;
  let hourlyCount = 0, hourlyWindow = Date.now();

  if (ckpt) {
    added = ckpt.added || 0; addedSize = ckpt.addedSize || 0;
    startSegment = ckpt.segment || 0;
    startPage = ckpt.page || 1; startRow = (ckpt.row || 0) + 1;
    if (ckpt.dailyDate === today) { dlToday = ckpt.dlToday || 0; }
    // 🔄 恢复小时计数（窗口未过期才有效）
    if (ckpt.hourlyWindow && Date.now() - ckpt.hourlyWindow < 3600000) {
      hourlyCount = ckpt.hourlyCount || 0; hourlyWindow = ckpt.hourlyWindow;
    }
    dailyDate = today;
    log(`\n🔄 续传: S${startSegment + 1}/${CONFIG.browseUrls.length} P${startPage}:${startRow - 1} | ${added}d ${(addedSize / 1e9).toFixed(2)}GB | 今日${dlToday}/${DAILY_LIMIT} | 本小时${hourlyCount}/${HOURLY_LIMIT}`);
  } else {
    log('\n🆕 全新开始');
  }

  const puppeteer = require('puppeteer');
  const launchOpts = { headless: CONFIG.headless ? 'new' : false, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
  if (CONFIG.chromeDataDir) launchOpts.userDataDir = CONFIG.chromeDataDir;
  const browser = await puppeteer.launch(launchOpts);
  browserRef = browser;
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR });

  for (let seg = startSegment; seg < CONFIG.browseUrls.length; seg++) {
  currentSegment = seg;
  const browseUrl = CONFIG.browseUrls[seg];
  const firstPage = seg === startSegment ? startPage : 1;
  let skipSegment = false;
  for (let pg = firstPage; pg <= CONFIG.maxPages; pg++) {
    log(`\nS${seg + 1}/${CONFIG.browseUrls.length} P${pg}`);

    try { await page.goto(pageUrl(browseUrl, pg), { waitUntil: 'networkidle2', timeout: 30000 }); }
    catch (e) { log(` ⚠️ 页面加载超时: ${e.message}`); await sleep(CONFIG.pageLoadWait); }

    await sleep(CONFIG.pageLoadWait);

    const rowCount = await page.evaluate(() => {
      let c = 0;
      document.querySelectorAll('table tbody tr td:last-child').forEach(td => { if (td.querySelectorAll('button').length >= 2) c++; });
      return c;
    });
    log(` 📦 ${rowCount} 个种子`);
    if (rowCount === 0) break;

    const skipTo = seg === startSegment && pg === startPage ? startRow : 0;

    for (let ri = skipTo; ri < rowCount; ri++) {
      if (addedSize >= CONFIG.maxBytes) {
        log(` 🏁 已达 ${(CONFIG.maxBytes / 1e12).toFixed(1)}TB 上限`);
        persistProgress(pg, ri, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow); await browser.close();
        log(`\nDONE ${added} torrents ${(addedSize / 1e9).toFixed(2)} GB`);
        return;
      }
      try {
        // 📅 每日/每小时限速检查
        const now = new Date(); const d = tzDate(CONFIG.tzOffset);
        if (d !== dailyDate) { dlToday = 0; dailyDate = d; hourlyCount = 0; hourlyWindow = Date.now(); }
        if (Date.now() - hourlyWindow > 3600000) { hourlyCount = 0; hourlyWindow = Date.now(); }
        if (dlToday >= DAILY_LIMIT) {
          const tomorrow = new Date(Date.now() + CONFIG.tzOffset * 3600000);
          tomorrow.setUTCHours(24, 0, 0, 0);
          const msUntilMidnight = tomorrow.getTime() - (Date.now() + CONFIG.tzOffset * 3600000);
          log(` 🛑 今日已达 ${DAILY_LIMIT}/${DAILY_LIMIT}，等待 ${Math.round(msUntilMidnight / 3600000)}h 至明天(TZ+${CONFIG.tzOffset})`);
          persistProgress(pg, ri - 1, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow);
          await sleep(msUntilMidnight + 60000);
          dlToday = 0; dailyDate = tzDate(CONFIG.tzOffset); hourlyCount = 0; hourlyWindow = Date.now();
          log(' 🌅 新的一天, 继续!');
        }
        if (hourlyCount >= HOURLY_LIMIT) {
          const waitMs = 3600000 - (Date.now() - hourlyWindow) + 30000;
          log(` ⏸️ 本小时 ${HOURLY_LIMIT}/${HOURLY_LIMIT}，等待 ${Math.round(waitMs / 60000)}m`);
          persistProgress(pg, ri - 1, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow);
          await sleep(waitMs);
          hourlyCount = 0; hourlyWindow = Date.now();
        }

        const result = await page.evaluate((rowIdx) => {
          let c = 0;
          for (const td of document.querySelectorAll('table tbody tr td:last-child')) {
            if (td.querySelectorAll('button').length < 2) continue;
            if (c !== rowIdx) { c++; continue; }
            const row = td.closest('tr');
            const link = row.querySelector('a[href*="/detail/"]');
            const sizeCell = row.querySelectorAll('td')[3];
            const id = link?.href?.match(/detail\/(\d+)/)?.[1] || '?';
            const size = sizeCell?.textContent?.trim() || '?';
            row.scrollIntoView({ behavior: 'instant', block: 'center' });
            return { id, size };
          }
          return {};
        }, ri);

        if (!result.id || result.id === '?') { log(` #${ri} ⏭️ 跳过`); continue; }

        const torrentBytes = parseSize(result.size);
        if (CONFIG.segmentMaxTorrentBytes > 0 && torrentBytes > CONFIG.segmentMaxTorrentBytes) {
          log(` ⏭️ #${result.id} ${result.size} > ${(CONFIG.segmentMaxTorrentBytes / 1048576).toFixed(0)}MB，结束当前切片`);
          persistProgress(1, -1, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow, seg + 1);
          skipSegment = true;
          break;
        }
        if (CONFIG.segmentMinTorrentBytes > 0 && torrentBytes < CONFIG.segmentMinTorrentBytes) {
          const isLastRow = (ri === rowCount - 1);
          if (isLastRow) {
            log(` ⏭️ 页末种子 ${result.size} < ${(CONFIG.segmentMinTorrentBytes / 1048576).toFixed(0)}MB，跳过整页`);
            persistProgress(pg, ri, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow);
            break;
          }
          log(` ⏭️ #${result.id} ${result.size} < ${(CONFIG.segmentMinTorrentBytes / 1048576).toFixed(0)}MB，跳过`);
          continue;
        }
        if (CONFIG.dryRun) {
          log(` DRY-RUN #${result.id} ${result.size} | no download`);
          persistProgress(pg, ri, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow);
          continue;
        }

        // 🕐 点击前做目录快照，只接受快照中不存在的新文件
        const beforeSnap = new Set(fs.readdirSync(DL_DIR));
        await page.evaluate((rowIdx) => {
          let c = 0;
          for (const td of document.querySelectorAll('table tbody tr td:last-child')) {
            if (td.querySelectorAll('button').length < 2) continue;
            if (c !== rowIdx) { c++; continue; }
            td.closest('tr').scrollIntoView({ behavior: 'instant', block: 'center' });
            setTimeout(() => td.querySelectorAll('button')[1].click(), 500);
            return;
          }
        }, ri);
        await sleep(CONFIG.downloadWait);

        // 🕐 找快照中不存在的新文件（比时间窗口更可靠）
        const newFiles = fs.readdirSync(DL_DIR)
          .filter(f => !beforeSnap.has(f))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(DL_DIR, f)).mtimeMs }))
          .sort((a, b) => a.mtime - b.mtime);
        if (newFiles.length === 0) { log(` #${result.id} ${result.size} ⚠️ 未下载`); persistProgress(pg, ri, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow); await sleep(CONFIG.betweenTorrent + Math.random() * 15000); continue; }

        const filePath = path.join(DL_DIR, newFiles[0].name);
        const data = fs.readFileSync(filePath);

        if (data.length < 100 || !data.subarray(0, 20).toString().includes('announce')) {
          log(` #${result.id} ❌ 种子损坏`);
          try { fs.unlinkSync(filePath); } catch (_) {}
          // The failed download request may still count against site quota.
          dlToday++; hourlyCount++;
          persistProgress(pg, ri, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow);
          await sleep(CONFIG.betweenTorrent + Math.random() * 15000); continue;
        }

        // Count successful download requests, not Transmission additions.
        dlToday++; hourlyCount++;

        const trResult = await trRpc('torrent-add', { metainfo: data.toString('base64'), paused: false });
        if (trResult === null) { try { fs.unlinkSync(filePath); } catch (_) {} persistProgress(pg, ri, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow); await sleep(CONFIG.betweenTorrent + Math.random() * 15000); continue; }
        added++;

        try { fs.unlinkSync(filePath); } catch (_) {}

        addedSize += torrentBytes;
        log(` ✅ #${result.id} ${result.size} | ${added}d ${(addedSize / 1e9).toFixed(2)} GB`);

        persistProgress(pg, ri, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow);
        await sleep(CONFIG.betweenTorrent + Math.random() * 15000);
      } catch (e) {
        log(` ❌ err: ${e.message}`);
        persistProgress(pg, ri, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow);
        await sleep(60000);
      }
    }
    if (skipSegment) break;
    persistProgress(pg, rowCount - 1, added, addedSize, dlToday, dailyDate, hourlyCount, hourlyWindow);
    if (addedSize >= CONFIG.maxBytes) break;
    await sleep(30000);
  }
  if (addedSize >= CONFIG.maxBytes) break;
  }
  await browser.close();
  log(`\nDONE ${added} torrents ${(addedSize / 1e9).toFixed(2)} GB`);
}

main().catch(e => { console.error('💥 致命错误:', e.message); try { fs.appendFileSync(LOG_FILE, 'FATAL ' + e.message + '\n'); } catch (_) {} process.exit(1); });
