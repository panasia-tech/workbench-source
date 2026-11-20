// 仓内实物高清矢量实拍与证据图生成器（离线零外链、永不裂图、严格区分实拍/库位/瑕疵/开箱/切帧）

function toDataUri(svg) {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg.trim())
}

const PALETTES = {
  monitor: { bg1: '#f1f5f9', bg2: '#e2e8f0', accent: '#1d4ed8', screen1: '#0f172a', screen2: '#1e3a8a' },
  phone:   { bg1: '#f8fafc', bg2: '#e2e8f0', accent: '#334155', screen1: '#111827', screen2: '#312e81' },
  audio:   { bg1: '#fafaf9', bg2: '#e7e5e4', accent: '#92400e', screen1: '#1c1917', screen2: '#44403c' },
  dryer:   { bg1: '#fdf4ff', bg2: '#f3e8ff', accent: '#7e22ce', screen1: '#3b0764', screen2: '#6b21a8' },
  mac:     { bg1: '#f8fafc', bg2: '#cbd5e1', accent: '#0f172a', screen1: '#334155', screen2: '#64748b' },
  camera:  { bg1: '#f4f4f5', bg2: '#d4d4d8', accent: '#ea580c', screen1: '#18181b', screen2: '#27272a' }
}

export function makeRealPhoto({ kind = 'monitor', code = 'SKU', model = '', badge = '本件实拍', defect = '' }) {
  const p = PALETTES[kind] || PALETTES.monitor
  let deviceSvg = ''
  if (kind === 'monitor') {
    deviceSvg = `
      <rect x="86" y="34" width="228" height="130" rx="7" fill="#0f172a" stroke="#334155" stroke-width="2"/>
      <rect x="93" y="41" width="214" height="114" rx="3" fill="url(#scr)"/>
      <circle cx="290" cy="70" r="24" fill="#38bdf8" opacity="0.22"/>
      <path d="M93 135 L155 96 L210 124 L262 84 L307 118 L307 155 L93 155 Z" fill="#3b82f6" opacity="0.32"/>
      <rect x="186" y="164" width="28" height="26" fill="#475569"/>
      <rect x="148" y="188" width="104" height="8" rx="4" fill="#334155"/>
    `
  } else if (kind === 'phone') {
    deviceSvg = `
      <rect x="152" y="26" width="96" height="172" rx="16" fill="#1e293b" stroke="#64748b" stroke-width="2.5"/>
      <rect x="158" y="33" width="84" height="158" rx="12" fill="url(#scr)"/>
      <rect x="186" y="38" width="28" height="7" rx="3.5" fill="#020617"/>
      ${defect ? '<path d="M214 35 L196 68 L226 82 L188 118" stroke="#fca5a5" stroke-width="2.2" fill="none"/>' : ''}
    `
  } else if (kind === 'audio') {
    deviceSvg = `
      <rect x="98" y="54" width="204" height="118" rx="12" fill="#1c1917" stroke="#78716c" stroke-width="3"/>
      <rect x="110" y="68" width="180" height="92" rx="6" fill="#292524" stroke="#a8a29e" stroke-width="1"/>
      <text x="200" y="118" text-anchor="middle" fill="#f59e0b" font-family="Georgia,serif" font-size="18" font-weight="bold">AUDIO</text>
      ${defect ? '<ellipse cx="248" cy="126" rx="18" ry="12" fill="#dc2626" opacity="0.35" stroke="#fca5a5" stroke-dasharray="3 2"/>' : ''}
    `
  } else if (kind === 'dryer') {
    deviceSvg = `
      <rect x="120" y="52" width="160" height="36" rx="18" fill="#6b21a8"/>
      <rect x="182" y="84" width="34" height="104" rx="10" fill="#a855f7"/>
      <circle cx="152" cy="70" r="10" fill="#f0abfc" opacity="0.6"/>
    `
  } else if (kind === 'camera') {
    deviceSvg = `
      <rect x="118" y="66" width="164" height="106" rx="12" fill="#18181b" stroke="#52525b" stroke-width="2"/>
      <rect x="148" y="48" width="56" height="22" rx="5" fill="#27272a"/>
      <circle cx="204" cy="120" r="38" fill="#09090b" stroke="#ea580c" stroke-width="3"/>
      <circle cx="204" cy="120" r="22" fill="#1e293b"/>
    `
  } else {
    deviceSvg = `
      <rect x="112" y="78" width="176" height="68" rx="14" fill="#cbd5e1" stroke="#64748b" stroke-width="2"/>
      <circle cx="200" cy="112" r="12" fill="#334155"/>
      <rect x="138" y="152" width="124" height="8" rx="4" fill="#94a3b8"/>
    `
  }

  return toDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${p.bg1}"/>
          <stop offset="100%" stop-color="${p.bg2}"/>
        </linearGradient>
        <linearGradient id="scr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${p.screen1}"/>
          <stop offset="100%" stop-color="${p.screen2}"/>
        </linearGradient>
      </defs>
      <rect width="400" height="240" fill="url(#bg)"/>
      <path d="M0 198 L400 198 L400 240 L0 240 Z" fill="#cbd5e1" opacity="0.45"/>
      ${deviceSvg}
      <rect x="14" y="14" width="92" height="24" rx="5" fill="#0f172a" opacity="0.82"/>
      <text x="60" y="30" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="11" font-weight="600">${badge}</text>
      <rect x="14" y="206" width="372" height="24" rx="5" fill="#ffffff" opacity="0.92"/>
      <text x="24" y="222" fill="#0f172a" font-family="monospace" font-size="11" font-weight="700">#${code}</text>
      <text x="376" y="222" text-anchor="end" fill="#475569" font-family="sans-serif" font-size="11">${model}</text>
    </svg>
  `)
}

export function makeLocationPhoto({ loc = 'A-02', code = 'SKU', bag = '' }) {
  return toDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240">
      <rect width="400" height="240" fill="#f1f5f9"/>
      <rect x="24" y="24" width="352" height="14" fill="#64748b"/>
      <rect x="24" y="168" width="352" height="16" fill="#475569"/>
      <rect x="34" y="24" width="12" height="196" fill="#334155"/>
      <rect x="354" y="24" width="12" height="196" fill="#334155"/>
      <rect x="64" y="62" width="136" height="106" rx="6" fill="#d97706" opacity="0.22" stroke="#b45309" stroke-width="2"/>
      <text x="132" y="112" text-anchor="middle" fill="#78350f" font-family="monospace" font-size="12" font-weight="700">${code}</text>
      <text x="132" y="132" text-anchor="middle" fill="#92400e" font-family="sans-serif" font-size="11">主机箱体 · RFID已绑</text>
      ${bag ? `
      <rect x="218" y="88" width="118" height="80" rx="8" fill="#eff6ff" stroke="#1d4ed8" stroke-width="2"/>
      <text x="277" y="122" text-anchor="middle" fill="#1e3a8a" font-family="monospace" font-size="12" font-weight="700">${bag}</text>
      <text x="277" y="142" text-anchor="middle" fill="#1d4ed8" font-family="sans-serif" font-size="11">专用编号附件袋</text>
      ` : ''}
      <rect x="130" y="170" width="140" height="36" rx="5" fill="#1d4ed8"/>
      <text x="200" y="193" text-anchor="middle" fill="#ffffff" font-family="monospace" font-size="15" font-weight="700">库位 ${loc}</text>
    </svg>
  `)
}

export function makeDefectPhoto({ title = '实测瑕疵特写', ts = '00:01:38', code = 'SKU', detail = '与卖家声明不一致' }) {
  return toDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240">
      <rect width="400" height="240" fill="#18181b"/>
      <rect x="32" y="28" width="336" height="164" rx="10" fill="#27272a" stroke="#52525b" stroke-width="1.5"/>
      <circle cx="200" cy="108" r="46" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-dasharray="6 4"/>
      <path d="M174 84 L204 112 L228 92 M186 128 L218 104" stroke="#fca5a5" stroke-width="3" stroke-linecap="round"/>
      <rect x="44" y="38" width="114" height="22" rx="4" fill="#dc2626"/>
      <text x="101" y="53" text-anchor="middle" fill="#ffffff" font-family="monospace" font-size="11" font-weight="700">● 证据帧 ${ts}</text>
      <text x="200" y="176" text-anchor="middle" fill="#fecaca" font-family="sans-serif" font-size="12.5" font-weight="600">${title} · ${detail}</text>
      <text x="36" y="220" fill="#a1a1aa" font-family="monospace" font-size="11">单件 #${code} · 原片防篡改哈希已存证</text>
    </svg>
  `)
}

export function makeUnboxFrame({ code = 'SKU', waybill = 'DEMO-SF-002', recording = true, stage = '拆封前外包装与打码面单核验' }) {
  return toDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 260">
      <rect width="480" height="260" fill="#0f172a"/>
      <rect x="24" y="22" width="432" height="216" rx="10" fill="#1e293b" stroke="${recording ? '#ef4444' : '#475569'}" stroke-width="2"/>
      <path d="M46 44 L72 44 M46 44 L46 70 M434 44 L408 44 M434 44 L434 70 M46 216 L72 216 M46 216 L46 190 M434 216 L408 216 M434 216 L434 190" stroke="#22c55e" stroke-width="2.5" fill="none"/>
      <rect x="136" y="64" width="208" height="124" rx="8" fill="#b45309" opacity="0.48" stroke="#f59e0b" stroke-width="2"/>
      <rect x="158" y="82" width="96" height="52" rx="4" fill="#f8fafc"/>
      <text x="166" y="99" fill="#0f172a" font-family="monospace" font-size="10" font-weight="700">${waybill}</text>
      <rect x="166" y="106" width="76" height="10" fill="#cbd5e1"/>
      <text x="166" y="127" fill="#64748b" font-family="sans-serif" font-size="9">客户隐私面单已受控遮蔽</text>
      <rect x="38" y="34" width="136" height="24" rx="5" fill="${recording ? '#dc2626' : '#334155'}"/>
      <text x="106" y="50" text-anchor="middle" fill="#ffffff" font-family="monospace" font-size="11.5" font-weight="700">${recording ? '● REC 工位高拍仪录制中' : '⏸ 待开启拆封前录像'}</text>
      <text x="240" y="212" text-anchor="middle" fill="#e2e8f0" font-family="sans-serif" font-size="12.5" font-weight="600">${stage} · #${code}</text>
    </svg>
  `)
}

export function makeSliceFrame({ idx = 1, ts = '01.2s', theme = 'aurora', quality = 'ok' }) {
  const themes = {
    aurora: ['#0f172a', '#1d4ed8', '#22d3ee'],
    sunset: ['#1e1b4b', '#be185d', '#fb923c'],
    forest: ['#052e16', '#15803d', '#86efac'],
    pure:   ['#f8fafc', '#e2e8f0', '#94a3b8'],
    blur:   ['#475569', '#64748b', '#94a3b8']
  }
  const [c1, c2, c3] = themes[theme] || themes.aurora
  const warnLabel = quality === 'blur' ? '模糊抖动' : quality === 'glare' ? '反光过曝' : quality === 'dup' ? '近重复帧' : quality === 'switch' ? '切换残影' : '清晰可用'
  const pillBg = quality === 'ok' ? '#059669' : '#dc2626'
  return toDataUri(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200">
      <defs>
        <linearGradient id="g${idx}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${c1}"/>
          <stop offset="60%" stop-color="${c2}"/>
          <stop offset="100%" stop-color="${c3}"/>
        </linearGradient>
      </defs>
      <rect width="320" height="200" fill="#e2e8f0"/>
      <rect x="34" y="20" width="252" height="142" rx="6" fill="#0f172a" stroke="#334155" stroke-width="3"/>
      <rect x="41" y="27" width="238" height="128" fill="url(#g${idx})" opacity="${quality === 'blur' ? '0.55' : '1'}"/>
      ${quality === 'glare' ? '<circle cx="210" cy="70" r="38" fill="#ffffff" opacity="0.72"/>' : ''}
      ${quality === 'switch' ? '<rect x="130" y="27" width="40" height="128" fill="#ffffff" opacity="0.38"/>' : ''}
      <rect x="144" y="162" width="32" height="16" fill="#475569"/>
      <rect x="112" y="178" width="96" height="6" rx="3" fill="#334155"/>
      <rect x="10" y="10" width="76" height="20" rx="4" fill="#0f172a" opacity="0.82"/>
      <text x="48" y="24" text-anchor="middle" fill="#fff" font-family="monospace" font-size="10.5">帧#${idx} ${ts}</text>
      <rect x="230" y="10" width="80" height="20" rx="4" fill="${pillBg}"/>
      <text x="270" y="24" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="10.5" font-weight="700">${warnLabel}</text>
    </svg>
  `)
}
