(() => {
  const lamp = document.getElementById('srv-lamp');
  const urlInput = document.getElementById('srv-url');
  const msgEl = document.getElementById('pop-msg');

  function sendBg(payload) {
    return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
  }

  async function init() {
    const res = await sendBg({ type: 'GET_SERVER_URL' });
    if (res?.url && urlInput) urlInput.value = res.url;
    const health = await sendBg({ type: 'COPILOT_API', method: 'GET', path: '/api/health' });
    if (lamp) {
      lamp.textContent = health?.ok ? '🟢 已连接全量工作台 (运行中)' : '🟡 全量工作台未开启 (离线防呆中)';
    }
  }

  document.getElementById('btn-toggle')?.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('goofish.com')) {
      if (msgEl) msgEl.textContent = '请先切换到闲鱼聊天标签页 goofish.com，或点下面按钮看演练沙盒';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_COPILOT' }, () => {
      if (chrome.runtime.lastError && msgEl) {
        msgEl.textContent = '请刷新一次闲鱼网页后生效';
      } else {
        window.close();
      }
    });
  });

  document.getElementById('btn-full')?.addEventListener('click', async () => {
    await sendBg({ type: 'OPEN_WORKBENCH', hash: '#/conversations' });
    window.close();
  });

  document.getElementById('btn-sandbox')?.addEventListener('click', async () => {
    await sendBg({ type: 'OPEN_WORKBENCH', hash: '#/im-sandbox' });
    window.close();
  });

  document.getElementById('btn-save')?.addEventListener('click', async () => {
    const url = urlInput?.value?.trim() || 'http://127.0.0.1:5360';
    await sendBg({ type: 'SAVE_SERVER_URL', url });
    if (msgEl) msgEl.textContent = '✓ 工作台地址已保存';
    init();
  });

  init();
})();
