addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

// 常量：代理域名
const PROXY_DOMAIN = "";

// 特殊处理规则
const specialCases = {
  "i.pximg.net": {
    "Origin": "DELETE",
    "Referer": "https://www.pixiv.net/"
  },
  "i-cf.pximg.net": {
    "Origin": "DELETE",
    "Referer": "https://www.pixiv.net/"
  },
  "*": {
    "Origin": "DELETE",
    "Referer": "DELETE"
  }
};

// 处理请求头中的特殊规则
function handleSpecialCases(request) {
  const url = new URL(request.url);
  const rules = specialCases[url.hostname] || specialCases["*"];
  for (const [key, value] of Object.entries(rules)) {
    switch (value) {
      case "KEEP":
        break;
      case "DELETE":
        request.headers.delete(key);
        break;
      default:
        request.headers.set(key, value);
        break;
    }
  }
}

// 处理 Set-Cookie 头，重写 Domain 和 Path
function handleSetCookieHeaders(response) {
  const newHeaders = new Headers(response.headers);

  // 删除旧的 Set-Cookie 头
  const setCookies = response.headers.getAll('Set-Cookie');
  newHeaders.delete('Set-Cookie');

  // 逐个处理 Set-Cookie 头
  setCookies.forEach(cookie => {
    let modifiedCookie = cookie;

    // 重写 Domain 属性为代理域名
    if (cookie.toLowerCase().includes('domain=')) {
      modifiedCookie = cookie.replace(/domain=[^;]+/i, `domain=${PROXY_DOMAIN}`);
    } else {
      // 如果没有指定 Domain，则设置为代理域名
      modifiedCookie += `; Domain=${PROXY_DOMAIN}`;
    }

    // 确保 Path 属性指向代理路径
    if (!/path=/i.test(modifiedCookie)) {
      modifiedCookie += `; Path=/`;
    }

    // 可选：添加 Secure 属性（确保仅通过 HTTPS 传输）
    // if (!/secure/i.test(modifiedCookie)) {
    //   modifiedCookie += `; Secure`;
    // }

    newHeaders.append('Set-Cookie', modifiedCookie);
  });

  return newHeaders;
}

// 处理请求
async function handleRequest(request) {
  try {
    const url = new URL(request.url);

    // 如果访问根目录，返回HTML
    if (url.pathname === "/") {
      return new Response(getRootHtml(), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8'
        }
      });
    }

    // 从请求路径中提取目标 URL
    const encodedActualUrlStr = url.pathname.slice(1); // 移除前导 '/'
    let actualUrlStr;
    try {
      actualUrlStr = decodeURIComponent(encodedActualUrlStr);
    } catch (e) {
      console.error('URL 解码失败:', e);
      return jsonResponse({ error: "Invalid URL encoding." }, 400);
    }

    // 判断用户输入的 URL 是否带有协议
    actualUrlStr = ensureProtocol(actualUrlStr, url.protocol);

    // 解析目标 URL
    const targetUrl = new URL(actualUrlStr);

    // 保留查询参数
    actualUrlStr += url.search;

    // 创建新 Headers 对象，排除以 'cf-' 开头的请求头
    const newHeaders = filterHeaders(request.headers, name => !name.toLowerCase().startsWith('cf-'));

    // 创建一个新的请求以访问目标 URL
    const modifiedRequest = new Request(actualUrlStr, {
      headers: newHeaders,
      method: request.method,
      body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
      redirect: 'manual' // 处理重定向
    });

    // 处理特殊请求头
    handleSpecialCases(modifiedRequest);

    // 发起对目标 URL 的请求
    const response = await fetch(modifiedRequest);

    // 处理 Set-Cookie 头
    const headersWithCookies = handleSetCookieHeaders(response);

    let body;

    // 处理重定向
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      return handleRedirect(response);
    } else if (response.headers.get("Content-Type")?.includes("text/html")) {
      // 处理 HTML 内容中的相对路径
      body = await handleHtmlContent(response, url.protocol, url.host, actualUrlStr);
      headersWithCookies.set('Content-Length', new TextEncoder().encode(body).length.toString());
    } else {
      // 对于非 HTML 内容，直接流式传输
      body = response.body;
    }

    // 创建修改后的响应对象
    const modifiedResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: headersWithCookies
    });

    // 添加禁用缓存的头部
    setNoCacheHeaders(modifiedResponse.headers);

    // 添加 CORS 头部，允许跨域访问
    setCorsHeaders(modifiedResponse.headers);

    return modifiedResponse;
  } catch (error) {
    console.error('请求处理失败:', error);
    // 如果请求目标地址时出现错误，返回带有错误消息的响应和状态码 500（服务器错误）
    return jsonResponse({ error: error.message }, 500);
  }
}

// 确保 URL 带有协议
function ensureProtocol(url, defaultProtocol) {
  return url.startsWith("http://") || url.startsWith("https://") ? url : defaultProtocol + "//" + url;
}

// 处理重定向
function handleRedirect(response) {
  const location = response.headers.get('location');
  if (!location) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  let modifiedLocation;
  try {
    // 判断重定向 URL 是否为绝对 URL
    const locationUrl = new URL(location, response.url);
    modifiedLocation = `/${encodeURIComponent(locationUrl.toString())}`;
  } catch (e) {
    // 如果是相对 URL，构建绝对 URL
    const baseUrl = new URL(response.url);
    const absoluteUrl = new URL(location, baseUrl);
    modifiedLocation = `/${encodeURIComponent(absoluteUrl.toString())}`;
  }

  // 移除旧的 Location 头，并设置新的
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Location', modifiedLocation);

  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

// 处理 HTML 内容中的相对路径
async function handleHtmlContent(response, protocol, host, actualUrlStr) {
  const originalText = await response.text();
  const targetOrigin = new URL(actualUrlStr).origin;
  const encodedOrigin = encodeURIComponent(targetOrigin);

  // 替换 href、src 和 action 属性中以 / 开头的相对路径
  const regex = /((href|src|action)=["'])\/(?!\/)/g;
  let modifiedText = originalText.replace(regex, `\$1/${encodedOrigin}/`);

  // 处理协议相对 URL，如 //example.com/path
  const protocolRelativeRegex = /((href|src|action)=["'])\/\/([^\/"']+)/g;
  modifiedText = modifiedText.replace(protocolRelativeRegex, (match, p1, p2) => {
    const newUrl = `/${encodeURIComponent(`https://${p2}`)}`;
    return `${p1}${newUrl}`;
  });

  return modifiedText;
}

// 返回 JSON 格式的响应
function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

// 过滤请求头
function filterHeaders(headers, filterFunc) {
  return new Headers([...headers].filter(([name]) => filterFunc(name)));
}

// 设置禁用缓存的头部
function setNoCacheHeaders(headers) {
  headers.set('Cache-Control', 'no-store');
}

// 设置 CORS 头部
function setCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  headers.set('Access-Control-Allow-Headers', '*');
}

// 返回根目录的 HTML
function getRootHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/materialize/1.0.0/css/materialize.min.css" rel="stylesheet">
  <title>Proxy Everything</title>
  <link rel="icon" type="image/png" href="https://s2.loli.net/2024/09/20/pgXFKc6UOASTyI9.png">
  <meta name="Description" content="Proxy Everything with CF Workers.">
  <meta property="og:description" content="Proxy Everything with CF Workers.">
  <meta property="og:image" content="https://img.icons8.com/color/1000/kawaii-bread-1.png">
  <meta name="robots" content="index, follow">
  <meta http-equiv="Content-Language" content="zh-CN">
  <meta name="copyright" content="Copyright © ymyuuu">
  <meta name="author" content="ymyuuu">
  <link rel="apple-touch-icon-precomposed" sizes="120x120" href="https://img.icons8.com/color/1000/kawaii-bread-1.png">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="viewport" content="width=device-width, user-scalable=no, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">
  <style>
      body, html {
          height: 100%;
          margin: 0;
      }
      .background {
          background-image: url('https://imgapi.cn/bing.php');
          background-size: cover;
          background-position: center;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
      }
      .card {
          background-color: rgba(255, 255, 255, 0.8);
          transition: background-color 0.3s ease, box-shadow 0.3s ease;
      }
      .card:hover {
          background-color: rgba(255, 255, 255, 1);
          box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.3);
      }
      .input-field input[type=text] {
          color: #2c3e50;
      }
      .input-field input[type=text]:focus+label {
          color: #2c3e50 !important;
      }
      .input-field input[type=text]:focus {
          border-bottom: 1px solid #2c3e50 !important;
          box-shadow: 0 1px 0 0 #2c3e50 !important;
      }
      .full-width {
          width: 100%;
      }
  </style>
</head>
<body>
  <div class="background">
      <div class="container">
          <div class="row">
              <div class="col s12 m8 offset-m2 l6 offset-l3">
                  <div class="card">
                      <div class="card-content">
                          <span class="card-title center-align"><i class="material-icons left">link</i>Proxy Everything</span>
                          <form id="urlForm" onsubmit="redirectToProxy(event)">
                              <div class="input-field">
                                  <input type="text" id="targetUrl" placeholder="在此输入目标地址" required>
                                  <label for="targetUrl">目标地址</label>
                              </div>
                              <button type="submit" class="btn waves-effect waves-light teal darken-2 full-width">跳转</button>
                          </form>
                      </div>
                  </div>
              </div>
          </div>
      </div>
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/materialize/1.0.0/js/materialize.min.js"></script>
  <script>
      function redirectToProxy(event) {
          event.preventDefault();
          const targetUrl = document.getElementById('targetUrl').value.trim();
          if (!targetUrl) {
              alert('请输入有效的URL');
              return;
          }
          const encodedUrl = encodeURIComponent(targetUrl);
          const currentOrigin = window.location.origin;
          window.open(\`${currentOrigin}/${encodedUrl}\`, '_blank');
      }
  </script>
</body>
</html>`;
}
