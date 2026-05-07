import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const compose = await fs.readFile('/home/kinso/sub2api/docker-compose.yml', 'utf8');
const envLine = (name) => {
  const m = compose.match(new RegExp(`- ${name}=(.*)`));
  if (!m) throw new Error(`missing ${name}`);
  return m[1].trim();
};
const adminEmail = envLine('ADMIN_EMAIL');
const adminPassword = envLine('ADMIN_PASSWORD');
const adminUrl = 'http://192.168.1.49:8080/admin/accounts';

async function loadCredentialFallbacks() {
  const { execFileSync } = await import('node:child_process');
  const sql = `select name, credentials->>'refresh_token' as refresh_token, notes from accounts where deleted_at is null`;
  const out = execFileSync('docker', ['exec','sub2api_postgres','psql','-U','sub2api','-d','sub2api','-At','-F','\t','-c', sql], { encoding: 'utf8' });
  const map = new Map();
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [email, refreshToken, notes] = line.split('\t');
    map.set(String(email).toLowerCase(), { refreshToken, notes });
  }
  return map;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const redactRaw = (s) => String(s || '').replace(/tok_[A-Za-z0-9]+/g, 'tok_***').replace(/(----\s*)[^-\n]+(\s*----\s*(?:Plus|Free|Team|Pro))/g, '$1***$2');
const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;

async function login(page) {
  await page.goto(adminUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  if (/\/login\b/i.test(new URL(page.url()).pathname)) {
    await page.getByPlaceholder(/email/i).fill(adminEmail);
    await page.getByPlaceholder(/password/i).fill(adminPassword);
    await page.locator('button[type=submit]').click();
    await page.waitForURL(u => !/\/login\b/i.test(u.pathname), { timeout: 30000 });
    await page.waitForTimeout(2500);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.getByText(/^Skip$/).click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function extractVisibleAccounts(page) {
  await page.goto(adminUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.keyboard.press('Escape').catch(() => {});
  const accounts = await page.evaluate(() => {
    const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
    const rows = [...document.querySelectorAll('table tbody tr, tr')];
    const out = [];
    for (const tr of rows) {
      const text = (tr.innerText || tr.textContent || '').replace(/\s+/g, ' ').trim();
      const emails = text.match(emailRe) || [];
      for (const email of emails) {
        if (!out.some(x => x.email.toLowerCase() === email.toLowerCase())) {
          const sm = text.match(/Token revoked\s*\(?401\)?|Revoked|Disabled|Failed|Error|Active|Enabled|OK|禁用|异常|错误|正常/i);
          out.push({ email, status: sm?.[0] || 'unknown', rowText: text.slice(0, 500) });
        }
      }
    }
    return out;
  });
  return accounts;
}

async function getRemarkForEmail(page, email) {
  await page.goto(adminUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const search = page.locator('input[placeholder*="Search"], input[placeholder*="搜索"], input[placeholder*="名称"]').first();
  if (await search.count()) {
    await search.fill(email);
    await page.waitForTimeout(1200);
  }
  const row = page.locator(`xpath=//*[contains(normalize-space(), "${email}")]/ancestor::tr[1]`).first();
  if (!(await row.count())) return '';
  const edit = row.locator('button:has-text("Edit"), button:has-text("编辑")').first();
  if (!(await edit.count())) return '';
  await edit.click({ force: true });
  await page.waitForTimeout(1500);
  const values = await page.locator('[role="dialog"] input, [role="dialog"] textarea, .modal input, .modal textarea').evaluateAll(nodes => nodes.map(n => n.value || '').filter(Boolean)).catch(() => []);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  const raw = values.find(v => v.includes('----') && v.includes('@')) || values.find(v => v.includes(email) && v.includes('tok_')) || '';
  return raw;
}

function classify(value) {
  const s = String(value || '').toLowerCase();
  if (/封禁|已封|banned|ban|disabled|suspended|deactivated|禁用/.test(s)) return 'banned';
  if (/正常|normal|ok|active|enabled|success/.test(s)) return 'normal';
  return 'unknown';
}

async function checkBan(rawLines) {
  const page = await context.newPage();
  const captured = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/api/openai-ban/check')) return;
    try { captured.push({ url: res.url(), status: res.status(), text: await res.text() }); } catch {}
  });
  await page.goto('https://ban.nloop.cc/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const textarea = page.locator('textarea').first();
  if (!(await textarea.count())) throw new Error('ban.nloop textarea not found');
  await textarea.fill(rawLines.join('\n'));
  const btn = page.locator('button:has-text("开始检测"), button:has-text("Start"), button:has-text("Check")').first();
  if (!(await btn.count())) throw new Error('ban.nloop start button not found');
  const waitResp = page.waitForResponse(r => r.url().includes('/api/openai-ban/check'), { timeout: 90000 }).catch(() => null);
  await btn.click({ force: true });
  await waitResp;
  await page.waitForTimeout(2000);
  const body = await page.locator('body').innerText().catch(() => '');
  await page.close();
  return { captured, body };
}

const context = await chromium.launchPersistentContext(path.resolve('.ban-check-profile'), { headless: true, viewport: { width: 1440, height: 1000 } });
try {
  const page = await context.newPage();
  await login(page);
  const accounts = await extractVisibleAccounts(page);
  console.log(`SUB2API_ACCOUNTS ${accounts.length}`);
  for (const a of accounts) console.log(`SUB2API_STATUS ${a.email} ${a.status}`);

  const credentialFallbacks = await loadCredentialFallbacks().catch(() => new Map());
  const enriched = [];
  for (const a of accounts) {
    let raw = await getRemarkForEmail(page, a.email);
    let source = raw ? 'remark' : 'missing';
    if (!raw) {
      const fb = credentialFallbacks.get(a.email.toLowerCase());
      if (fb?.refreshToken) {
        raw = `${a.email} ---- ${fb.refreshToken}`;
        source = 'db_refresh_token';
      }
    }
    enriched.push({ ...a, raw, rawSource: source });
    console.log(`REMARK ${a.email} ${source}`);
  }
  await page.close();

  const rawLines = enriched.map(a => a.raw || a.email).filter(Boolean);
  let ban = null;
  if (rawLines.length) ban = await checkBan(rawLines);

  const results = new Map(enriched.map(a => [a.email.toLowerCase(), { email: a.email, sub2api: a.status, ban: 'unknown' }]));
  for (const cap of ban?.captured || []) {
    try {
      const json = JSON.parse(cap.text);
      if (json?.ok && Array.isArray(json.results)) {
        for (const item of json.results) {
          const itemText = JSON.stringify(item);
          for (const a of enriched) {
            if (itemText.toLowerCase().includes(a.email.toLowerCase())) {
              const r = results.get(a.email.toLowerCase());
              const st = String(item.status || '').toLowerCase();
              r.ban = st === 'normal' ? 'normal' : (['banned','ban','disabled','suspended','deactivated'].includes(st) ? 'banned' : 'unknown');
            }
          }
        }
      }
    } catch {}
  }
  // fallback classify from body snippets only when no structured API result was available
  const body = ban?.body || '';
  for (const a of enriched) {
    const r = results.get(a.email.toLowerCase());
    if (r.ban !== 'unknown') continue;
    const idx = body.toLowerCase().indexOf(a.email.toLowerCase());
    if (idx >= 0) r.ban = classify(body.slice(Math.max(0, idx - 300), idx + 800));
  }
  console.log('BAN_SUMMARY_BEGIN');
  for (const r of results.values()) console.log(`${r.email}\t${r.sub2api}\t${r.ban}`);
  console.log('BAN_SUMMARY_END');
} finally {
  await context.close();
}
