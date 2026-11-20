/**
 * OAuth 授权页 / 出错页：服务端直出的独立 HTML（不进前端打包，不加载任何脚本），
 * 所有动态内容一律转义；响应头里禁止被嵌进 iframe（防点击劫持），见 OAuthController.htmlHeaders。
 */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char: string) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

const STYLE = `
  :root { --bg: #f5f6f8; --card: #ffffff; --text: #1f2329; --muted: #646a73; --line: #dee0e3;
    --primary: #1f6feb; --primary-text: #ffffff; --warn-bg: #fff7e6; --warn-text: #8a5300; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #17181a; --card: #222326; --text: #ebebeb; --muted: #a6a9ad; --line: #3a3c40;
      --primary: #4c8dff; --primary-text: #ffffff; --warn-bg: #3a2e14; --warn-text: #f5c66b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px 16px; background: var(--bg); color: var(--text);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line);
    border-radius: 12px; padding: 28px 24px; }
  .brand { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; margin-bottom: 16px; }
  .brand img { width: 20px; height: 20px; }
  h1 { font-size: 19px; line-height: 1.4; margin: 0 0 12px; word-break: break-all; }
  p { margin: 0 0 10px; }
  .muted { color: var(--muted); font-size: 13px; }
  .warn { background: var(--warn-bg); color: var(--warn-text); border-radius: 8px; padding: 8px 12px; font-size: 13px; }
  .actions { display: flex; gap: 12px; margin: 20px 0 12px; }
  button { flex: 1; font: inherit; padding: 10px 0; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--line); background: var(--card); color: var(--text); }
  button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-text); font-weight: 600; }
  a { color: var(--primary); }
`;

function page(title: string, faviconHref: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${escapeHtml(faviconHref)}">
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="brand"><img src="${escapeHtml(faviconHref)}" alt="">泛亚员工工作台</div>
${body}
</main>
</body>
</html>`;
}

export interface ConsentPageInput {
  /** 应用自报的名字，没报给「未命名应用」 */
  appName: string;
  userName: string;
  /** 授权后回到哪（站点名），known=false 时多一行提醒 */
  redirect: { label: string; known: boolean };
  /** 签名票据，同意 / 拒绝时原样交回 */
  request: string;
  action: string;
  faviconHref: string;
}

export function renderConsentPage(input: ConsentPageInput): string {
  const appName = escapeHtml(input.appName || '未命名应用');
  const userName = escapeHtml(input.userName || '你');
  const warn = input.redirect.known
    ? ''
    : '<p class="warn">这个应用不在常用 AI 工具名单里。不是你自己在配置，就点拒绝。</p>';
  return page(
    `授权 ${input.appName || '未命名应用'}`,
    input.faviconHref,
    `<h1>${appName} 申请使用你的工作台账号</h1>
<p>同意后，它能以 <strong>${userName}</strong> 的身份调用工作台的 AI 工具（查任务等），权限和你本人一样。</p>
<p class="muted">授权后回到：${escapeHtml(input.redirect.label)}</p>
${warn}
<form method="post" action="${escapeHtml(input.action)}">
<input type="hidden" name="request" value="${escapeHtml(input.request)}">
<div class="actions">
<button type="submit" name="decision" value="deny">拒绝</button>
<button type="submit" name="decision" value="approve" class="primary">同意</button>
</div>
</form>
<p class="muted">随时可以在工作台「我的 → API Key」里收回。</p>`,
  );
}

export function renderErrorPage(input: {
  title: string;
  message: string;
  faviconHref: string;
}): string {
  return page(
    input.title,
    input.faviconHref,
    `<h1>${escapeHtml(input.title)}</h1>
<p class="muted">${escapeHtml(input.message)}</p>`,
  );
}
