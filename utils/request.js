const { baseUrl, testbaseUrl } = require('./config');

function resolveRequestTarget(url) {
  const path = String(url || '');
  if (path.indexOf('/api/delivery/') === 0 || path.indexOf('/test-api/') === 0) {
    return { base: testbaseUrl, path: path.replace(/^\/test-api\//, '/api/') };
  }
  return { base: baseUrl, path };
}

function joinUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  const target = resolveRequestTarget(url);

  // 如果是本地开发环境 (127.0.0.1 或 localhost)，把路径里的 /api 截掉以绕过 Nginx 代理逻辑
  let finalPath = target.path.replace(/^\//, '');
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(target.base)) {
    if (finalPath.startsWith('api/')) {
      finalPath = finalPath.substring(4); // 截去 'api/'
    }
  }

  return target.base.replace(/\/$/, '') + '/' + finalPath;
}

function getCookieFromHeader(header) {
  const raw = header && (header['Set-Cookie'] || header['set-cookie']);
  if (!raw) return '';
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).split(';')[0]).filter(Boolean).join('; ');
  }
  return String(raw)
    .split(/,(?=[^;,]+=)/)
    .map((item) => item.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function mergeCookie(nextCookie) {
  if (!nextCookie) return;
  const app = getApp();
  const map = {};
  String(app.globalData.cookie || '').split(';').forEach((part) => {
    const text = part.trim();
    if (!text) return;
    const idx = text.indexOf('=');
    map[idx >= 0 ? text.slice(0, idx) : text] = text;
  });
  String(nextCookie).split(';').forEach((part) => {
    const text = part.trim();
    if (!text) return;
    const idx = text.indexOf('=');
    map[idx >= 0 ? text.slice(0, idx) : text] = text;
  });
  app.globalData.cookie = Object.keys(map).map((key) => map[key]).join('; ');
}

function decodeUtf8Mojibake(text) {
  if (typeof text !== 'string') return text;
  try {
    let encoded = '';
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code > 255) return text;
      encoded += `%${code.toString(16).padStart(2, '0')}`;
    }
    return decodeURIComponent(encoded);
  } catch (err) {
    return text;
  }
}

function request(options) {
  const app = getApp();
  const header = Object.assign({}, options.header || {});
  if (app.globalData.cookie) header.Cookie = app.globalData.cookie;

  return new Promise((resolve, reject) => {
    wx.request({
      url: joinUrl(options.url),
      method: options.method || 'GET',
      data: options.data || {},
      header,
      timeout: options.timeout || 30000,
      success(res) {
        mergeCookie(getCookieFromHeader(res.header));
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject(new Error((res.data && (res.data.message || res.data.msg)) || `HTTP ${res.statusCode}`));
        }
      },
      fail(err) {
        reject(err);
      },
    });
  });
}

function uploadFile(url, filePath) {
  const app = getApp();
  const header = {};
  if (app.globalData.cookie) header.Cookie = app.globalData.cookie;

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: joinUrl(url),
      filePath,
      name: 'file',
      header,
      success(res) {
        mergeCookie(getCookieFromHeader(res.header));
        const rawBody = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        const bodyText = decodeUtf8Mojibake(rawBody);
        console.log('[uploadRegisterFile] status', res.statusCode, 'raw', rawBody, 'decoded', bodyText);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${bodyText.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          if (parsed && typeof parsed.message === 'string') parsed.message = decodeUtf8Mojibake(parsed.message);
          if (parsed && parsed.data && typeof parsed.data.message === 'string') parsed.data.message = decodeUtf8Mojibake(parsed.data.message);
          resolve(parsed);
        } catch (err) {
          reject(new Error(`响应不是 JSON: ${bodyText.slice(0, 200)}`));
        }
      },
      fail(err) {
        console.error('[uploadRegisterFile] fail', err);
        reject(err);
      },
    });
  });
}

module.exports = {
  request,
  uploadFile,
  joinUrl,
};