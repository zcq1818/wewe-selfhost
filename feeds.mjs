/**
 * wewe-selfhost —— 完全自控的公众号转 RSS
 *
 * 基于 weread-omni SDK，全程只连微信读书/微信官方域名
 * （i.weread.qq.com、open.weixin.qq.com、mp.weixin.qq.com），
 * 不经过任何第三方转发服务，登录态只保存在本机。
 *
 * 用法：
 *   node feeds.mjs login            扫码登录（生成 PNG 二维码）
 *   node feeds.mjs resolve <url>    解析一篇文章链接 → 公众号账号 ID
 *   node feeds.mjs refresh          订阅配置里的公众号并生成 RSS/JSON
 *
 * 前置：手机微信读书账号需“养熟”。若 refresh 报 -2041（人机验证），
 *       说明账号/设备指纹被风控，先正常用几天微信读书（点开公众号文章）再试。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import {
  AccountManager,
  buildPublicAccountFeed,
  readPublicAccountArticle,
} from 'weread-omni';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'subscriptions.json');
const FEEDS_DIR = join(__dirname, 'feeds');
const QR_PATH = join(__dirname, 'login-qr.png');

// 用系统默认看图工具直接弹出二维码图片
function openFile(path) {
  const commands = {
    win32: ['cmd', ['/c', 'start', '', path]],
    darwin: ['open', [path]],
    linux: ['xdg-open', [path]],
  };
  const [cmd, args] = commands[process.platform] || commands.linux;
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

function isRiskControl(err) {
  const msg = String(err?.message || err);
  return msg.includes('-2041') || msg.includes('human verification') || msg.includes('verification challenge');
}

async function login() {
  const manager = new AccountManager();
  console.log('正在获取登录二维码…');
  try {
    const result = await manager.login('default', {
      onQr: async (url) => {
        await QRCode.toFile(QR_PATH, url, { width: 480, margin: 2, errorCorrectionLevel: 'M' });
        if (openFile(QR_PATH)) {
          console.log('二维码图片已自动弹出，请用手机微信扫码并确认授权。');
        } else {
          console.log('二维码已生成：' + QR_PATH + '（请手动打开）');
          console.log('请用手机微信扫码，并在手机上确认授权。');
        }
      },
      onStatus: async (status) => console.log('状态：' + status),
    });
    console.log('登录成功：' + JSON.stringify(result));
  } finally {
    if (existsSync(QR_PATH)) {
      // 登录完成即删除二维码图片，避免残留会话引用
      const { rmSync } = await import('node:fs');
      rmSync(QR_PATH, { force: true });
    }
  }
}

async function resolveArticle(url) {
  const manager = new AccountManager();
  const { canonical } = await manager.open('default');
  const result = await readPublicAccountArticle(canonical, url);
  const accountId = result.diagnostics?.find((d) => d.accountId)?.accountId;
  console.log(JSON.stringify({
    title: result.title,
    accountName: result.accountName,
    accountId,
    reviewId: result.reviewId,
    status: result.status,
  }, null, 2));
  if (accountId) {
    console.log(`\n把 "${accountId}" 加入 subscriptions.json 的 accounts 数组即可。`);
  }
}

async function refresh() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const accountIds = new Set([...(config.accounts || []).map(String)]);
  for (const url of config.urls || []) {
    try {
      const manager = new AccountManager();
      const { canonical } = await manager.open('default');
      const result = await readPublicAccountArticle(canonical, url);
      const id = result.diagnostics?.find((d) => d.accountId)?.accountId;
      if (id) accountIds.add(id);
    } catch (err) {
      console.warn(`解析链接失败（跳过）：${url} —— ${err.message}`);
    }
  }

  if (accountIds.size === 0) {
    console.error('subscriptions.json 里没有可用的公众号，先填 accounts 或 urls。');
    process.exit(1);
  }

  mkdirSync(FEEDS_DIR, { recursive: true });
  const manager = new AccountManager();
  const { canonical } = await manager.open('default');

  for (const accountId of accountIds) {
    try {
      await canonical.publicAccounts.subscribe(accountId).catch(() => { /* 已订阅则忽略 */ });
    } catch (err) {
      if (isRiskControl(err)) {
        console.error(`⚠️ ${accountId} 订阅被风控拦截（-2041），账号需养号。`);
        continue;
      }
    }

    for (const format of ['rss', 'json']) {
      try {
        const out = await buildPublicAccountFeed(
          canonical,
          { kind: 'account', accountId },
          { format, limit: 50 },
        );
        const file = join(FEEDS_DIR, `${accountId}.${format}`);
        writeFileSync(file, out.content, 'utf8');
        console.log(`✔ ${accountId}.${format}  ${out.itemCount} 篇 → ${file}`);
      } catch (err) {
        if (isRiskControl(err)) {
          console.error(`⚠️ ${accountId} 抓取被风控拦截（-2041）：账号需养号，先在手机上正常用几天微信读书。`);
        } else {
          console.error(`✖ ${accountId}.${format} 失败：${err.message}`);
        }
      }
    }
  }
}

const [cmd, ...args] = process.argv.slice(2);
(async () => {
  try {
    if (cmd === 'login') await login();
    else if (cmd === 'resolve') {
      if (!args[0]) { console.error('用法：node feeds.mjs resolve <文章链接>'); process.exit(1); }
      await resolveArticle(args[0]);
    } else if (cmd === 'refresh') await refresh();
    else {
      console.log('用法：\n  node feeds.mjs login\n  node feeds.mjs resolve <url>\n  node feeds.mjs refresh');
    }
  } catch (err) {
    if (isRiskControl(err)) {
      console.error('⚠️ 微信读书人机验证（-2041）：请先在手机上正常使用微信读书养号，过几天再试。');
    } else {
      console.error('运行出错：', err);
    }
    process.exit(1);
  }
})();
