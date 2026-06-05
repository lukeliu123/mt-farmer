// Private Tracker Farmer: checkpoint/log files default to $HOME.
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');

// 🔧 环境变量配置（TR_URL/TR_USER/TR_PASS 必须设置，其他有默认值）
const TR_URL=process.env.TR_URL||'';
const TR_USER=process.env.TR_USER||'';
const TR_PASS=process.env.TR_PASS||'';
const DRY_RUN=process.env.DRY_RUN!=='false';
const DOWNLOADS_ENABLED=process.env.DOWNLOADS_ENABLED==='true';
const ACK_SITE_RULES=process.env.ACK_SITE_RULES==='true';
if(!DRY_RUN&&(!TR_URL||!TR_USER||!TR_PASS)){console.error('❌ Active downloading requires TR_URL TR_USER TR_PASS');process.exit(1);}
const TR_AUTH='Basic '+Buffer.from(TR_USER+':'+TR_PASS).toString('base64');
const DL_DIR=process.env.DL_DIR||'/tmp/mt_downloads';
const HOME=os.homedir();
const LOG=process.env.LOG_FILE||path.join(HOME,'.mt_farmer.log');
const CKPT=process.env.CHECKPOINT_FILE||path.join(HOME,'.mt_farmer_checkpoint.json');
const SORT=process.env.BROWSE_URL||process.env.MT_BROWSE||'';
const BROWSE_URLS=(process.env.BROWSE_URL_LIST||process.env.MT_BROWSE_LIST||SORT).split(/[\n,]+/).map(s=>s.trim()).filter(Boolean);
const MAX=parseInt(process.env.MAX_BYTES||'3298534883328',10); // OpenClaw版默认3TB
const SEGMENT_MAX_TORRENT_BYTES=parseInt(process.env.SEGMENT_MAX_TORRENT_BYTES||'367001600',10);
const SEGMENT_MIN_TORRENT_BYTES=parseInt(process.env.SEGMENT_MIN_TORRENT_BYTES||'0',10);
const MAX_PAGES=parseInt(process.env.MAX_PAGES||'100',10);
const CDP_HOST=process.env.CDP_HOST||'http://127.0.0.1:18800';
const PAGE_LOAD_WAIT=parseInt(process.env.PAGE_LOAD_WAIT||'10000',10);
const DOWNLOAD_WAIT=parseInt(process.env.DOWNLOAD_WAIT||'12000',10);
const BETWEEN_TORRENT=parseInt(process.env.BETWEEN_TORRENT||'45000',10);
// Timezone offset used for daily quota windows.
const TZ_OFFSET=parseInt(process.env.TZ_OFFSET||'8',10);
let trSid=null;

// ── 日志 + 自动 rotate ──────────────────────────────────────────────────
let logLineCount=0;
function rotateLog(){
  try{
    if(!fs.existsSync(LOG))return;
    const lines=fs.readFileSync(LOG,'utf8').split('\n').length;
    if(lines<5000){logLineCount=lines;return;}
    try{fs.unlinkSync(LOG+'.2');}catch(_){}
    try{fs.renameSync(LOG+'.1',LOG+'.2');}catch(_){}
    try{fs.renameSync(LOG,LOG+'.1');}catch(_){}
    fs.writeFileSync(LOG,'');
    logLineCount=0;
  }catch(_){}
}
function log(m){
  const t=new Date().toISOString().slice(11,19);
  console.log(t+' '+m);
  try{fs.appendFileSync(LOG,t+' '+m+'\n');}catch(_){}
  logLineCount++;
  if(logLineCount>=5000)rotateLog();
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function pageUrl(base,page){
  try{const u=new URL(base);u.searchParams.set('pageNumber',String(page));return u.toString();}
  catch(_){return base+(base.includes('?')?'&':'?')+'pageNumber='+page;}
}

// 🕐 获取指定时区的日期字符串 YYYY-MM-DD
function tzDate(offsetHours){const d=new Date(Date.now()+offsetHours*3600000);return d.toISOString().slice(0,10);}

function loadCkpt(){
  try{return JSON.parse(fs.readFileSync(CKPT,'utf8'));}catch(e){return null;}
}
// 🔒 原子写入：先写 .tmp 再 rename，断电不丢数据
// 🔒 统一更新 globals + 原子写 checkpoint（所有分支都必须通过此函数持久化）
function persistProgress(page,row,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow,segment=currentSegment){
  currentSegment=segment;currentPage=page;currentRow=row;globalAdded=added;globalAddedSize=addedSize;
  globalDlToday=dlToday;globalDailyDate=dailyDate;globalHourlyCount=hourlyCount;globalHourlyWindow=hourlyWindow;
  try{
    fs.writeFileSync(CKPT+'.tmp',JSON.stringify({segment,page,row,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow,time:new Date().toISOString()}));
    fs.renameSync(CKPT+'.tmp',CKPT);
  }catch(e){}
}

// 🧮 扩展单位解析：支持 KB/MB/GB/TB + KiB/MiB/GiB/TiB + 逗号分隔
function parseSize(text){
  if(!text)return 0;
  const m=text.toUpperCase().match(/([\d.,]+)\s*(KIB|MIB|GIB|TIB|KB|MB|GB|TB|B)/);
  if(!m)return 0;
  const v=parseFloat(m[1].replace(/,/g,''));
  const u=m[2];
  if(u==='KIB'||u==='KB')return Math.round(v*1024);
  if(u==='MIB'||u==='MB')return Math.round(v*1048576);
  if(u==='GIB'||u==='GB')return Math.round(v*1073741824);
  if(u==='TIB'||u==='TB')return Math.round(v*1099511627776);
  return Math.round(v); // B
}

async function tr(method,args={},retry=true){
  if(!trSid){const r=await fetch(TR_URL,{headers:{Authorization:TR_AUTH},signal:AbortSignal.timeout(10000)});trSid=r.headers.get('X-Transmission-Session-Id')||'';}
  const r=await fetch(TR_URL,{method:'POST',headers:{Authorization:TR_AUTH,'X-Transmission-Session-Id':trSid,'Content-Type':'application/json'},body:JSON.stringify({method,arguments:args}),signal:AbortSignal.timeout(15000)});
  if(r.status===409&&retry){const ns=r.headers.get('X-Transmission-Session-Id');if(ns){trSid=ns;return tr(method,args,false);}}
  const j=await r.json();if(j.result!=='success'){
    if(j.result&&j.result.includes('duplicate')){log(' ⏭️ 重复种子, 跳过');return null;}
    throw new Error(j.result);
  }
  // TR 4.x returns torrent-duplicate for existing torrents with result=success
  if(j.arguments&&j.arguments['torrent-duplicate']){log(' ⏭️ 重复种子, 跳过');return null;}
  return j.arguments;
}

// 🔴 SIGINT / SIGTERM 保护
let currentSegment=0,currentPage=1,currentRow=0,globalAdded=0,globalAddedSize=0;
let globalDlToday=0,globalDailyDate='',globalHourlyCount=0,globalHourlyWindow=0;
process.on('SIGINT',()=>{
  persistProgress(currentPage,currentRow,globalAdded,globalAddedSize,globalDlToday,globalDailyDate,globalHourlyCount,globalHourlyWindow);
  log('\n⚠️ SIGINT 已保存断点，安全退出');
  process.exit(0);
});
process.on('SIGTERM',()=>{
  persistProgress(currentPage,currentRow,globalAdded,globalAddedSize,globalDlToday,globalDailyDate,globalHourlyCount,globalHourlyWindow);
  log('\n⚠️ SIGTERM 已保存断点，安全退出');
  process.exit(0);
});

async function main(){
  if(BROWSE_URLS.length===0){console.error('❌ 请设置 BROWSE_URL 或 BROWSE_URL_LIST 环境变量');process.exit(1);}
  if(!DRY_RUN&&(!DOWNLOADS_ENABLED||!ACK_SITE_RULES)){console.error('❌ Active downloading requires DRY_RUN=false DOWNLOADS_ENABLED=true ACK_SITE_RULES=true');process.exit(1);}
  fs.mkdirSync(DL_DIR,{recursive:true});
  rotateLog();
  const ckpt=loadCkpt();
  let added=0,addedSize=0,startSegment=0,startPage=1,startRow=0;

  // Daily/hourly download counters. Keep conservative defaults.
  const today=tzDate(TZ_OFFSET);
  let dlToday=0,dailyDate=today;
  const DAILY_LIMIT=parseInt(process.env.DAILY_LIMIT||'950',10);
  const HOURLY_LIMIT=parseInt(process.env.HOURLY_LIMIT||'90',10);
  let hourlyCount=0,hourlyWindow=Date.now();

  if(ckpt){
    added=ckpt.added||0; addedSize=ckpt.addedSize||0;
    startSegment=ckpt.segment||0;
    startPage=ckpt.page||1; startRow=(ckpt.row||0)+1;
    if(ckpt.dailyDate===today){dlToday=ckpt.dlToday||0;}
    // 🔄 恢复小时计数（窗口未过期才有效）
    if(ckpt.hourlyWindow&&Date.now()-ckpt.hourlyWindow<3600000){
      hourlyCount=ckpt.hourlyCount||0;hourlyWindow=ckpt.hourlyWindow;
    }
    dailyDate=today;
    log(`\n🔄 续传: S${startSegment+1}/${BROWSE_URLS.length} P${startPage}:${startRow-1} | ${added}d ${(addedSize/1e9).toFixed(2)}GB | 今日${dlToday}/${DAILY_LIMIT} | 本小时${hourlyCount}/${HOURLY_LIMIT}`);
  }else{
    log('\n🆕 全新开始');
  }

  for(let seg=startSegment;seg<BROWSE_URLS.length;seg++){
  currentSegment=seg;
  const browseUrl=BROWSE_URLS[seg];
  const firstPage=seg===startSegment?startPage:1;
  let skipSegment=false;
  for(let page=firstPage;page<=MAX_PAGES;page++){
    log(`\nS${seg+1}/${BROWSE_URLS.length} P${page}`);

    const url=pageUrl(browseUrl,page);
    try{execFileSync('openclaw',['browser','open',url,'--label','p'+page],{timeout:15000,stdio:'pipe'});}catch(e){}
    await sleep(PAGE_LOAD_WAIT);

    let mt=null;
    for(let r=0;r<5;r++){try{const t=await(await fetch(CDP_HOST+'/json',{signal:AbortSignal.timeout(5000)})).json();mt=t.find(x=>x.url.includes('browse')&&x.url.includes('sort=size'));if(mt)break;await sleep(5000);}catch(e){}}
    if(!mt){log(' ❌ CDP 超时');persistProgress(page-1,0,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow);break;}

    const WebSocket=require('ws');
    const ws=new WebSocket(mt.webSocketDebuggerUrl);
    await new Promise(r=>ws.on('open',r));
    let mid=0,pend=new Map();
    ws.on('message',d=>{const m=JSON.parse(d);if(m.id&&pend.has(m.id))pend.get(m.id)(m.result);});
    function cdp(m,pa={}){return new Promise(r=>{const id=++mid;pend.set(id,r);ws.send(JSON.stringify({id,method:m,params:pa}));})}

    await cdp('Runtime.enable');
    await cdp('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:DL_DIR,eventsEnabled:true});

    const cr=await cdp('Runtime.evaluate',{expression:"(()=>{let c=0;document.querySelectorAll('table tbody tr td:last-child').forEach(td=>{if(td.querySelectorAll('button').length>=2)c++});return c;})()"});
    const rc=parseInt(cr?.result?.value)||0;
    log(` 📦 ${rc} 个种子`);
    if(rc===0)break;

    const skipTo=seg===startSegment&&page===startPage?startRow:0;
    for(let ri=skipTo;ri<rc;ri++){
      if(addedSize>=MAX){log(` 🏁 ${(MAX/1e12).toFixed(1)}TB!`);persistProgress(page,ri,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow);ws.close();log(`\nDONE ${added} torrents ${(addedSize/1e9).toFixed(2)}GB`);return;}

      try{
        // 📅 每日/每小时限速检查
        const now=new Date();const d=tzDate(TZ_OFFSET);
        if(d!==dailyDate){dlToday=0;dailyDate=d;hourlyCount=0;hourlyWindow=Date.now();}
        if(Date.now()-hourlyWindow>3600000){hourlyCount=0;hourlyWindow=Date.now();}
        if(dlToday>=DAILY_LIMIT){
          // 计算到下一个 TZ_OFFSET 午夜的毫秒数
          const tomorrow=new Date(Date.now()+TZ_OFFSET*3600000);
          tomorrow.setUTCHours(24,0,0,0);
          const msUntilMidnight=tomorrow.getTime()-(Date.now()+TZ_OFFSET*3600000);
          log(` 🛑 今日已达 ${DAILY_LIMIT}/${DAILY_LIMIT}，等待 ${Math.round(msUntilMidnight/3600000)}h 至明天(TZ+${TZ_OFFSET})`);
          persistProgress(page,ri-1,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow);
          await sleep(msUntilMidnight+60000);
          dlToday=0;dailyDate=tzDate(TZ_OFFSET);hourlyCount=0;hourlyWindow=Date.now();
          log(' 🌅 新的一天, 继续!');
        }
        if(hourlyCount>=HOURLY_LIMIT){
          const waitMs=3600000-(Date.now()-hourlyWindow)+30000;
          log(` ⏸️ 本小时 ${HOURLY_LIMIT}/${HOURLY_LIMIT}，等待 ${Math.round(waitMs/60000)}m`);
          persistProgress(page,ri-1,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow);
          await sleep(waitMs);
          hourlyCount=0;hourlyWindow=Date.now();
        }

        const ur=await cdp('Runtime.evaluate',{expression:'location.href'});
        if(!ur?.result?.value?.includes('browse')){log(' ⚠️ 跳转, 重新导航');await cdp('Page.navigate',{url:pageUrl(browseUrl,page)});await sleep(6000);}

        const si=await cdp('Runtime.evaluate',{expression:"(()=>{let c=0;for(const td of document.querySelectorAll('table tbody tr td:last-child')){if(td.querySelectorAll('button').length<2)continue;if(c!=="+ri+"){c++;continue;}const r=td.closest('tr');const a=r.querySelector('a[href*=\"/detail/\"]');const sz=r.querySelectorAll('td')[3]?.textContent?.trim();return JSON.stringify({id:a?.href?.match(/detail\\/(\\d+)/)?.[1]||'?',size:sz||'?'})}return'{}'})()"});
        const info=JSON.parse(si?.result?.value||'{}');
        if(!info.id||info.id==='?'){log(` #${ri} ⏭️ 跳过`);continue;}
        const sz=parseSize(info.size);
        if(SEGMENT_MAX_TORRENT_BYTES>0&&sz>SEGMENT_MAX_TORRENT_BYTES){
          log(` ⏭️ #${info.id} ${info.size} > ${(SEGMENT_MAX_TORRENT_BYTES/1048576).toFixed(0)}MB，结束当前切片`);
          persistProgress(1,-1,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow,seg+1);
          skipSegment=true;
          break;
        }
        if(SEGMENT_MIN_TORRENT_BYTES>0&&sz<SEGMENT_MIN_TORRENT_BYTES){
          // 升序排列时，当前页末种子仍低于最小阈值 → 整页跳过
          const isLastRow=(ri===rc-1);
          if(isLastRow){
            log(` ⏭️ 页末种子 ${info.size} < ${(SEGMENT_MIN_TORRENT_BYTES/1048576).toFixed(0)}MB，跳过整页`);
            persistProgress(page,ri,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow);
            break;
          }
          log(` ⏭️ #${info.id} ${info.size} < ${(SEGMENT_MIN_TORRENT_BYTES/1048576).toFixed(0)}MB，跳过`);
          continue;
        }
        if(DRY_RUN){
          log(` DRY-RUN #${info.id} ${info.size} | no download`);
          persistProgress(page,ri,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow);
          continue;
        }

        // 🕐 点击前做目录快照，只接受快照中没有的新文件
        const beforeSnap=new Set(fs.readdirSync(DL_DIR));
        await cdp('Runtime.evaluate',{expression:"(()=>{let c=0;for(const td of document.querySelectorAll('table tbody tr td:last-child')){if(td.querySelectorAll('button').length<2)continue;if(c!=="+ri+"){c++;continue;}td.closest('tr').scrollIntoView({behavior:'instant',block:'center'});setTimeout(()=>td.querySelectorAll('button')[1].click(),500);return'ok'}return'nf'})()",awaitPromise:true});
        await sleep(DOWNLOAD_WAIT);

        // 🕐 找快照中不存在的新文件
        const newFiles=fs.readdirSync(DL_DIR)
          .filter(f=>!beforeSnap.has(f))
          .map(f=>({name:f,mtime:fs.statSync(path.join(DL_DIR,f)).mtimeMs}))
          .sort((a,b)=>a.mtime-b.mtime);
        if(newFiles.length===0){log(` #${info.id} ${info.size} ⚠️ 未下载`);persistProgress(page,ri,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow);await sleep(BETWEEN_TORRENT+Math.random()*15000);continue;}

        const fp=path.join(DL_DIR,newFiles[0].name);
        const data=fs.readFileSync(fp);

        if(data.length<100||!data.subarray(0,20).toString().includes('announce')){
          log(` #${info.id} ❌ 种子损坏`);
          try{fs.unlinkSync(fp);}catch(e){}
          // The failed download request may still count against site quota.
          dlToday++;hourlyCount++;
          persistProgress(page,ri,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow);
          await sleep(BETWEEN_TORRENT+Math.random()*15000);continue;
        }

        // Count successful download requests, not Transmission additions.
        dlToday++;hourlyCount++;

        const trResult=await tr('torrent-add',{metainfo:data.toString('base64'),paused:false});
        if(trResult===null){
          try{fs.unlinkSync(fp);}catch(e){}
          persistProgress(page,ri,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow);
          await sleep(BETWEEN_TORRENT+Math.random()*15000);continue;}
        added++;

        try{fs.unlinkSync(fp);}catch(e){}

        addedSize+=sz;
        log(` ✅ #${info.id} ${info.size} | ${added}d ${(addedSize/1e9).toFixed(2)}GB`);

        persistProgress(page,ri,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow);

        await sleep(BETWEEN_TORRENT+Math.random()*15000);
      }catch(e){
        log(` ❌ err: ${e.message}`);
        persistProgress(page,ri,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow);
        try{ws.close();}catch(_){}
        await sleep(60000);
      }
    }
    try{ws.close();}catch(_){}
    if(skipSegment)break;
    persistProgress(page,rc-1,added,addedSize,dlToday,dailyDate,hourlyCount,hourlyWindow);
    if(addedSize>=MAX)break;
    await sleep(30000);
  }
  if(addedSize>=MAX)break;
  }
  log(`\nDONE ${added} torrents ${(addedSize/1e9).toFixed(2)}GB`);
}

main().catch(e=>{try{fs.appendFileSync(LOG,'FATAL '+e.message+'\n');}catch(e){}process.exit(1);});
