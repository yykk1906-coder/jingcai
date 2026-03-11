/**
 * Cloudflare Worker — 竞彩数据代理
 *
 * 路由：
 *   OPTIONS  任意路径        → CORS 预检
 *   ANY      /af/*           → api-football 代理（需 Header: X-Api-Key）
 *   GET      /zhcw           → 并发拉取五种竞彩数据（spf/crs/rq/tjq/bqc）
 *   其他                     → 404
 */

// ── 常量 ──────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'X-Api-Key, Content-Type',
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  'Content-Type': 'application/json; charset=utf-8',
};

/** 各竞彩类型对应的 zhcw transactionType */
const ZHCW_APIS = {
  spf:  '10002101',  // 胜平负
  crs:  '10002102',  // 比分
  rq:   '10002103',  // 让球胜平负
  tjq:  '10002104',  // 总进球
  bqc:  '10002105',  // 半全场
};

const ZHCW_BASE =
  'https://jc.zhcw.com/port/client_json.php?callback=&transactionType=';

const ZHCW_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  'Referer': 'https://jc.zhcw.com/',
};

/** 单次请求超时 (ms) */
const TIMEOUT_MS = 8000;

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 带超时的 fetch */
function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** 统一 JSON 响应 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

/** 解析 zhcw JSONP 响应文本 → 对象；失败抛出 */
function parseZhcwJsonp(text) {
  // zhcw 格式：callback({...}) 或 ({...})
  const m = text.match(/\((\{[\s\S]*\})\)\s*;?\s*$/);
  if (!m) throw new Error('JSONP 格式解析失败');
  return JSON.parse(m[1]);
}

// ── 路由处理 ──────────────────────────────────────────────────────────────────

/** /af/* → api-football 代理 */
async function handleApiFootball(req, url) {
  // API Key 从请求头取，不暴露在 URL 中
  const apiKey = req.headers.get('X-Api-Key') || '';
  if (!apiKey) {
    return jsonResponse({ error: '缺少 X-Api-Key 请求头' }, 401);
  }

  // 去掉 /af 前缀，保留剩余路径和查询参数
  const afPath = url.pathname.slice(3) + url.search;
  const afUrl = 'https://v3.football.api-sports.io' + afPath;

  try {
    const r = await fetchWithTimeout(afUrl, {
      headers: {
        'x-apisports-key': apiKey,
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!r.ok) {
      return jsonResponse(
        { error: `上游返回 ${r.status}` },
        r.status,
      );
    }
    const data = await r.json();
    return jsonResponse(data);
  } catch (e) {
    const isTimeout = e.name === 'TimeoutError';
    return jsonResponse(
      { error: isTimeout ? '请求上游超时' : e.message },
      isTimeout ? 504 : 502,
    );
  }
}

/** /zhcw → 并发拉取五种竞彩赔率数据 */
async function handleZhcw() {
  const tasks = Object.entries(ZHCW_APIS).map(async ([key, code]) => {
    try {
      const r = await fetchWithTimeout(ZHCW_BASE + code, {
        headers: ZHCW_HEADERS,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      const json = parseZhcwJsonp(text);
      return [key, json];
    } catch (e) {
      // 单接口失败不阻断其他，返回空壳便于前端判断
      return [key, { data: [], error: e.message }];
    }
  });

  const results = await Promise.all(tasks);
  return jsonResponse(Object.fromEntries(results));
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

export default {
  async fetch(req) {
    // CORS 预检
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 仅允许 GET
    if (req.method !== 'GET') {
      return jsonResponse({ error: '不支持该方法' }, 405);
    }

    const url = new URL(req.url);

    if (url.pathname.startsWith('/af/') || url.pathname === '/af') {
      return handleApiFootball(req, url);
    }

    if (url.pathname === '/zhcw') {
      return handleZhcw();
    }

    return jsonResponse({ error: '路由不存在' }, 404);
  },
};
