/**
 * 拾光 RSS —— 自托管公众号转 RSS 网页服务
 *
 * 后端入口：把 vendored 的 weread-omni SDK 封装成 HTTP 接口，
 * 并提供网页界面（web/index.html）。全程只连微信读书/微信官方域名。
 *
 * 启动：node server.mjs   （默认端口 3000，可用 PORT 环境变量覆盖）
 */
import { createServer } from 'node:http';
import {
  readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import {
  AccountManager,
  buildPublicAccountFeed,
  readPublicAccountArticle,
} from 'weread-omni';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, 'web');
const FEEDS_DIR = join(__dirname, 'feeds');
const PORT = Number(process.env.PORT) || 3000;

// ---------------- 登录状态（单次登录，避免并发扫码） ----------------
const login = { active: false, status: 'idle', qrDataUrl: null, error: null, result: null };

async function startLogin() {
  if (login.active) return;
  Object.assign(login, { active: true, status: 'waiting_qr', qrDataUrl: null, error: null, result: null });
  const manager = new AccountManager();
  try {
    const result = await manager.login('default', {
      onQr: async (url) => {
        const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
        Object.assign(login, { status: 'ready', qrDataUrl: dataUrl });
      },
      onStatus: async (s) => {
        if (s === 'scanned') login.status = 'scanned';
        if (s === 'confirmed') login.status = 'confirmed';
      },
    });
    Object.assign(login, { status: 'success', result });
  } catch (e) {
    Object.assign(login, { status: 'error', error: String(e?.message || e) });
  } finally {
    login.active = false;
  }
}

function getAccounts() {
  return new AccountManager().accounts();
}

async function openAccount() {
  const manager = new AccountManager();
  const list = manager.accounts();
  if (list.length === 0) return null;
  return manager.open(list[0].account);
}

function isRiskControl(err) {
  const msg = String(err?.message || err);
  return msg.includes('-2041') || msg.includes('human verification') || msg.includes('verification challenge');
}

// ---------------- 工具 ----------------
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function listFeeds() {
  mkdirSync(FEEDS_DIR, { recursive: true });
  return readdirSync(FEEDS_DIR)
    .filter((f) => /\.(rss|atom|json)$/.test(f))
    .map((name) => ({ name, url: `/feeds/${name}` }));
}

// ---------------- 请求处理 ----------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    // 网页界面
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(WEB_DIR, 'index.html')));
      return;
    }

    // 生成的 feed 文件
    if (path.startsWith('/feeds/')) {
      const name = basename(path);
      const file = join(FEEDS_DIR, name);
      if (!existsSync(file)) return json(res, 404, { error: 'not found' });
      const content = readFileSync(file);
      const type = name.endsWith('.json') ? 'application/json' : 'application/xml';
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      return res.end(content);
    }

    // 综合状态
    if (path === '/api/status') {
      const accounts = getAccounts();
      const loggedIn = accounts.length > 0;
      let subscriptions = [];
      if (loggedIn) {
        try {
          const opened = await openAccount();
          const page = await opened.canonical.publicAccounts.subscriptions({ count: 200 });
          subscriptions = page.accounts.map((a) => ({ accountId: a.accountId, title: a.title, cover: a.cover }));
        } catch { /* 订阅列表偶发风控，忽略 */ }
      }
      return json(res, 200, { loggedIn, accounts, subscriptions, feeds: listFeeds() });
    }

    // 登录：启动
    if (path === '/api/login/start' && req.method === 'POST') {
      startLogin();
      return json(res, 200, { started: true });
    }

    // 登录：轮询状态
    if (path === '/api/login/status') {
      return json(res, 200, { status: login.status, qrDataUrl: login.qrDataUrl, error: login.error, result: login.result });
    }

    // 订阅：添加（accountId 或 url）
    if (path === '/api/subscribe' && req.method === 'POST') {
      const opened = await openAccount();
      if (!opened) return json(res, 401, { error: '尚未登录，请先扫码登录' });
      const body = await readBody(req);
      let accountId = body.accountId;
      if (!accountId && body.url) {
        const r = await readPublicAccountArticle(opened.canonical, body.url);
        accountId = r.diagnostics?.find((d) => d.accountId)?.accountId;
      }
      if (!accountId) return json(res, 400, { error: '缺少 accountId 或 url' });
      try {
        const r = await opened.canonical.publicAccounts.subscribe(accountId);
        return json(res, 200, { ok: true, accountId, result: r });
      } catch (e) {
        return json(res, isRiskControl(e) ? 429 : 500, { ok: false, error: String(e?.message || e), riskControl: isRiskControl(e) });
      }
    }

    // 订阅：取消
    if (path.startsWith('/api/subscribe/') && req.method === 'DELETE') {
      const opened = await openAccount();
      if (!opened) return json(res, 401, { error: '尚未登录' });
      const accountId = basename(path);
      try {
        await opened.canonical.publicAccounts.unsubscribe(accountId);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e?.message || e) });
      }
    }

    // 刷新：为所有订阅生成 RSS/JSON
    if (path === '/api/refresh' && req.method === 'POST') {
      const opened = await openAccount();
      if (!opened) return json(res, 401, { error: '尚未登录' });

      const ids = new Set();
      try {
        const cfg = JSON.parse(readFileSync(join(__dirname, 'subscriptions.json'), 'utf8'));
        (cfg.accounts || []).forEach((x) => ids.add(String(x)));
      } catch { /* 无配置 */ }
      try {
        const page = await opened.canonical.publicAccounts.subscriptions({ count: 200 });
        page.accounts.forEach((a) => ids.add(a.accountId));
      } catch { /* 订阅列表偶发风控 */ }

      const results = [];
      for (const accountId of ids) {
        for (const format of ['rss', 'json']) {
          try {
            const out = await buildPublicAccountFeed(opened.canonical, { kind: 'account', accountId }, { format, limit: 50 });
            writeFileSync(join(FEEDS_DIR, `${accountId}.${format}`), out.content, 'utf8');
            results.push({ accountId, format, ok: true, itemCount: out.itemCount });
          } catch (e) {
            results.push({ accountId, format, ok: false, error: String(e?.message || e), riskControl: isRiskControl(e) });
          }
        }
      }
      return json(res, 200, { results, feeds: listFeeds() });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`拾光 RSS 已启动：http://localhost:${PORT}`);
});
