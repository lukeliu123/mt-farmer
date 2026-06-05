#!/usr/bin/env node

const base = process.env.BASE_BROWSE_URL || process.env.BROWSE_URL || process.env.MT_BROWSE || '';
const startYear = parseInt(process.env.START_YEAR || '2015', 10);
const endYear = parseInt(process.env.END_YEAR || String(new Date().getFullYear()), 10);
const tzOffset = parseInt(process.env.TZ_OFFSET || '10', 10);

if (!base) {
  console.error('Please set BASE_BROWSE_URL or BROWSE_URL');
 process.exit(1);
}

function timestampAtLocalMidnight(year, month, day) {
 return Math.floor(Date.UTC(year, month - 1, day, -tzOffset, 0, 0) / 1000);
}

function withDateRange(url, start, end) {
 const u = new URL(url);
 u.searchParams.set('sort', 'size:ascend');
 u.searchParams.delete('pageNumber');
 u.searchParams.set('uploadDateStart', String(start));
 u.searchParams.set('uploadDateEnd', String(end));
 return u.toString();
}

const urls = [];
for (let year = startYear; year <= endYear; year++) {
 urls.push(withDateRange(
 base,
 timestampAtLocalMidnight(year, 1, 1),
 timestampAtLocalMidnight(year, 7, 1) - 1
 ));
 urls.push(withDateRange(
 base,
 timestampAtLocalMidnight(year, 7, 1),
 timestampAtLocalMidnight(year + 1, 1, 1) - 1
 ));
}

process.stdout.write(urls.join('\n') + '\n');
