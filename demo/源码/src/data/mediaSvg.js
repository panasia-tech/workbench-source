// 生成高辨识度「本机一物一码实拍图 / 瑕疵微距特写 / 屏幕纯色测试图」SVG Data URI
// 确保离线/单文件直开 100% 清晰可见，且每台机器的桌面背景、条码贴纸、角度与瑕疵标注各不相同

function svgToUri(svg) {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg.trim());
}

const PALETTES = {
  monitor: { mat: '#1e293b', frame: '#0f172a', accent: '#38bdf8', screen: '#0284c7' },
  dyson: { mat: '#27272a', frame: '#be185d', accent: '#f472b6', screen: '#db2777' },
  mac: { mat: '#1f2937', frame: '#cbd5e1', accent: '#60a5fa', screen: '#94a3b8' },
  nas: { mat: '#18181b', frame: '#27272a', accent: '#22c55e', screen: '#10b981' },
  speaker: { mat: '#292524', frame: '#44403c', accent: '#f59e0b', screen: '#78716c' },
  asus: { mat: '#172554', frame: '#1e1b4b', accent: '#f97316', screen: '#ea580c' },
};

export function makeRealPhoto({
  kind = 'monitor',
  skuCode = '513211540233-A',
  shortCode = '0233',
  angle = '正面亮屏定妆照',
  grade = '95新',
  sn = 'SN-PH27M9981',
  defectText = '',
  timecode = '00:04',
  variant = 1,
}) {
  const p = PALETTES[kind] || PALETTES.monitor;
  const isDefect = Boolean(defectText);
  const bg2 = variant % 2 === 0 ? '#0f172a' : p.mat;

  let deviceGraphic = '';
  if (kind === 'monitor' || kind === 'asus') {
    const scrFill = variant === 2 ? '#16a34a' : isDefect ? '#334155' : p.screen;
    deviceGraphic = `
      <rect x="115" y="46" width="250" height="142" rx="8" fill="${p.frame}" stroke="#475569" stroke-width="3"/>
      <rect x="123" y="54" width="234" height="122" rx="4" fill="${scrFill}" opacity="0.9"/>
      <path d="M123 145 L210 75 L285 130 L357 68 L357 176 L123 176 Z" fill="#ffffff" opacity="0.14"/>
      <rect x="222" y="188" width="36" height="32" fill="#475569"/>
      <rect x="182" y="218" width="116" height="12" rx="4" fill="#64748b"/>
      <text x="240" y="116" text-anchor="middle" fill="#ffffff" font-size="14" font-weight="700" font-family="sans-serif">${
        variant === 2 ? '全屏纯色无坏点实测' : angle
      }</text>
    `;
  } else if (kind === 'dyson') {
    deviceGraphic = `
      <circle cx="240" cy="108" r="46" fill="${p.frame}" stroke="#fbcfe8" stroke-width="3"/>
      <circle cx="240" cy="108" r="21" fill="${bg2}"/>
      <rect x="226" y="150" width="28" height="82" rx="10" fill="#52525b" stroke="#a1a1aa" stroke-width="2"/>
      <rect x="298" y="158" width="66" height="48" rx="8" fill="#3f3f46" stroke="#71717a"/>
      <text x="331" y="186" text-anchor="middle" fill="#e4e4e7" font-size="11" font-weight="700">#BAG风嘴齐</text>
    `;
  } else if (kind === 'mac') {
    deviceGraphic = `
      <rect x="140" y="76" width="200" height="110" rx="22" fill="#e2e8f0" stroke="#94a3b8" stroke-width="3"/>
      <circle cx="240" cy="131" r="18" fill="#64748b"/>
      <rect x="165" y="196" width="150" height="18" rx="5" fill="#334155"/>
      <text x="240" y="209" text-anchor="middle" fill="#cbd5e1" font-size="10">雷雳接口×4 实测全通</text>
    `;
  } else if (kind === 'nas') {
    deviceGraphic = `
      <rect x="148" y="58" width="184" height="154" rx="10" fill="#27272a" stroke="#52525b" stroke-width="3"/>
      <rect x="162" y="72" width="34" height="126" rx="4" fill="#18181b" stroke="#3f3f46"/>
      <rect x="203" y="72" width="34" height="126" rx="4" fill="#18181b" stroke="#3f3f46"/>
      <rect x="244" y="72" width="34" height="126" rx="4" fill="#18181b" stroke="#3f3f46"/>
      <rect x="285" y="72" width="34" height="126" rx="4" fill="#18181b" stroke="#3f3f46"/>
      <circle cx="179" cy="86" r="4" fill="#22c55e"/>
      <circle cx="220" cy="86" r="4" fill="#22c55e"/>
      <circle cx="261" cy="86" r="4" fill="#22c55e"/>
      <circle cx="302" cy="86" r="4" fill="#22c55e"/>
    `;
  } else {
    deviceGraphic = `
      <rect x="182" y="54" width="116" height="164" rx="36" fill="#44403c" stroke="#a8a29e" stroke-width="3"/>
      <ellipse cx="240" cy="74" rx="46" ry="12" fill="#292524"/>
      <circle cx="240" cy="140" r="32" fill="#1c1917" stroke="#78716c" stroke-width="2"/>
    `;
  }

  const defectOverlay = isDefect
    ? `
      <circle cx="282" cy="212" r="24" fill="none" stroke="#ef4444" stroke-width="3.5" stroke-dasharray="6 3"/>
      <line x1="298" y1="196" x2="342" y2="164" stroke="#ef4444" stroke-width="2.5"/>
      <rect x="255" y="136" width="210" height="30" rx="8" fill="#dc2626"/>
      <text x="360" y="156" text-anchor="middle" fill="#ffffff" font-size="12" font-weight="700" font-family="sans-serif">微距实拍：${defectText}</text>
    `
    : '';

  return svgToUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300" width="480" height="300">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${bg2}"/>
          <stop offset="100%" stop-color="#090d16"/>
        </linearGradient>
      </defs>
      <rect width="480" height="300" fill="url(#g)"/>
      <!-- 工位防静电桌垫网格 -->
      <g stroke="#ffffff" stroke-opacity="0.06" stroke-width="1">
        <line x1="0" y1="240" x2="480" y2="240"/>
        <line x1="60" y1="0" x2="60" y2="300"/>
        <line x1="180" y1="0" x2="180" y2="300"/>
        <line x1="300" y1="0" x2="300" y2="300"/>
        <line x1="420" y1="0" x2="420" y2="300"/>
      </g>
      <!-- 顶部高拍仪水印条 -->
      <rect x="14" y="12" width="236" height="26" rx="7" fill="#000000" fill-opacity="0.58"/>
      <circle cx="28" cy="25" r="5" fill="${isDefect ? '#ef4444' : '#22c55e'}"/>
      <text x="40" y="29" fill="#f8fafc" font-size="11.5" font-weight="700" font-family="monospace">仓管高拍仪 · ${timecode} · ${grade}</text>
      <rect x="368" y="12" width="98" height="26" rx="7" fill="${isDefect ? '#b91c1c' : '#1d4ed8'}"/>
      <text x="417" y="29" text-anchor="middle" fill="#ffffff" font-size="11.5" font-weight="700" font-family="sans-serif">${
        isDefect ? '瑕疵特写' : '本机实拍'
      }</text>

      ${deviceGraphic}
      ${defectOverlay}

      <!-- 左下角一物一码实体贴纸同框 -->
      <rect x="16" y="246" width="248" height="42" rx="8" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
      <rect x="24" y="253" width="4" height="28" fill="#0f172a"/>
      <rect x="31" y="253" width="2" height="28" fill="#0f172a"/>
      <rect x="36" y="253" width="5" height="28" fill="#0f172a"/>
      <rect x="44" y="253" width="2" height="28" fill="#0f172a"/>
      <rect x="49" y="253" width="4" height="28" fill="#0f172a"/>
      <text x="62" y="265" fill="#0f172a" font-size="11.5" font-weight="800" font-family="monospace">货号 ${skuCode} (#${shortCode})</text>
      <text x="62" y="281" fill="#475569" font-size="10.5" font-weight="600" font-family="monospace">原厂 ${sn}</text>

      <!-- 右下角角度说明 -->
      <rect x="278" y="252" width="186" height="32" rx="8" fill="#0f172a" fill-opacity="0.82" stroke="#334155"/>
      <text x="371" y="272" text-anchor="middle" fill="#e2e8f0" font-size="11.5" font-weight="700" font-family="sans-serif">${angle}</text>
    </svg>
  `);
}
