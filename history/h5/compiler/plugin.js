import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, compileStyle } from '@vue/compiler-sfc'
import {
  DESKTOP_ROOT, MP_ROOT, OVERRIDE_ROOT, REPO_ROOT, RUNTIME_ROOT,
  existsLogical, isMpSource, isUnder, logicalOf, physical, readJsonLogical, readLogical, resetPatches, scopeIdOf, toPosix,
} from './paths.js'
import { DELIMITERS, compileWxml, resolveWxsPath, scanPlaceholderClasses } from './wxml.js'
import { compileWxss } from './wxss.js'
import { transformCjs } from './cjs.js'

// Vite 插件：让浏览器直接跑 miniprogram/ 的源码。
//   virtual:mp-app          app.json / app.js / app.wxss / 各页面懒加载入口
//   x.wxml?mp-page|mp-comp  页面 / 组件：WXML → Vue render、配套 JS / WXS / 组件
//   x.wxml?mp-desktop       页面的电脑版模板（src/desktop/ 下同路径的 .wxml），≥1024 宽时代替原模板
//   x.wxss?mp-css           样式（页面和组件是 scoped，app.wxss 是全局）
//   x.wxs?mp-wxs            WXS 模块
//   *.js（小程序源码）      CommonJS → ESM

const APP_ID = 'virtual:mp-app'
const RESOLVED_APP_ID = '\0virtual:mp-app'
const QUERY_RE = /[?&]mp-(page|comp|desktop|css|wxs)\b/

function splitQuery(id) {
  const i = id.indexOf('?')
  return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)]
}

function walkFiles(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walkFiles(full, ext, out)
    else if (ent.name.endsWith(ext)) out.push(full)
  }
  return out
}

function hostNameOf(logicalBase) {
  const base = path.posix.basename(logicalBase)
  return base === 'index' ? path.posix.basename(path.posix.dirname(logicalBase)) : base
}

/** usingComponents 里的路径 → 组件的逻辑路径（不带扩展名） */
function resolveComponentPath(spec, fromLogicalBase) {
  const p = spec.startsWith('/') ? spec.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(fromLogicalBase), spec))
  if (existsLogical(`${p}.wxml`)) return p
  if (existsLogical(`${p}/index.wxml`)) return `${p}/index`
  throw new Error(`${fromLogicalBase}.json：找不到组件 ${spec}`)
}

export default function mpPlugin() {
  let state = null

  // 全局信息：app.json、所有出现过的 placeholder-class、组件标签名 → 宿主名
  function getState() {
    if (state) return state
    const appJson = readJsonLogical('app.json')
    const placeholderClasses = new Set()
    for (const f of [...walkFiles(MP_ROOT, '.wxml'), ...walkFiles(OVERRIDE_ROOT, '.wxml'), ...walkFiles(DESKTOP_ROOT, '.wxml')]) {
      scanPlaceholderClasses(fs.readFileSync(f, 'utf8'), placeholderClasses)
    }
    const hostOfTag = {}
    const jsons = [...walkFiles(MP_ROOT, '.json'), ...walkFiles(OVERRIDE_ROOT, '.json')]
    for (const f of jsons) {
      const logical = logicalOf(f)
      if (logical.endsWith('project.config.json') || logical.endsWith('project.private.config.json') || logical === 'sitemap.json') continue
      let json
      try { json = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
      for (const [tag, spec] of Object.entries(json.usingComponents || {})) {
        try { hostOfTag[tag] = hostNameOf(resolveComponentPath(spec, logical.replace(/\.json$/, ''))) } catch { /* 页面编译时再报 */ }
      }
    }
    if (appJson.tabBar && appJson.tabBar.custom) hostOfTag['custom-tab-bar'] = 'custom-tab-bar'
    state = { appJson, aliases: appJson.resolveAlias || {}, placeholderClasses, hostOfTag }
    return state
  }

  function cssId(logicalWxss, global) {
    return `${toPosix(physical(logicalWxss))}?mp-css${global ? '&global' : ''}&lang.css`
  }

  function genApp(ctx) {
    const { appJson } = getState()
    ctx.addWatchFile(physical('app.json'))
    const pages = appJson.pages || []
    const pageJsons = {}
    for (const p of pages) {
      if (existsLogical(`${p}.json`)) ctx.addWatchFile(physical(`${p}.json`))
      const j = readJsonLogical(`${p}.json`)
      pageJsons[p] = {
        navigationBarTitleText: j.navigationBarTitleText,
        enablePullDownRefresh: !!j.enablePullDownRefresh,
        onReachBottomDistance: j.onReachBottomDistance,
        backgroundColor: j.backgroundColor,
        navigationStyle: j.navigationStyle,
      }
    }
    const lines = [`import * as __app from ${JSON.stringify(toPosix(physical('app.js')))};`]
    if (existsLogical('app.wxss')) lines.push(`import ${JSON.stringify(cssId('app.wxss', true))};`)
    lines.push('export const appDef = __app.__mp;')
    lines.push(`export const appJson = ${JSON.stringify({ pages, window: appJson.window || {}, tabBar: appJson.tabBar || null })};`)
    lines.push(`export const pageJsons = ${JSON.stringify(pageJsons)};`)
    lines.push('export const pageLoaders = {')
    for (const p of pages) {
      if (!existsLogical(`${p}.wxml`)) throw new Error(`app.json 里的页面 ${p} 没有 .wxml`)
      lines.push(`  ${JSON.stringify(p)}: () => import(${JSON.stringify(`${toPosix(physical(`${p}.wxml`))}?mp-page`)}),`)
    }
    lines.push('};')
    const customTab = appJson.tabBar && appJson.tabBar.custom && existsLogical('custom-tab-bar/index.wxml')
    lines.push(customTab
      ? `export const tabBarLoader = () => import(${JSON.stringify(`${toPosix(physical('custom-tab-bar/index.wxml'))}?mp-comp`)});`
      : 'export const tabBarLoader = null;')
    return lines.join('\n')
  }

  /** WXML → Vue render 代码 + 用到的 WXS / 组件的 import。电脑版模板按它顶替的页面算路径和 scope */
  function compileView(ctx, { source, file, logicalBase, kind, where }) {
    const { appJson } = getState()
    const jsonLogical = `${logicalBase}.json`
    if (existsLogical(jsonLogical)) ctx.addWatchFile(physical(jsonLogical))
    const json = readJsonLogical(jsonLogical)
    const using = { ...(appJson.usingComponents || {}), ...(json.usingComponents || {}) }
    const host = kind === 'component' ? hostNameOf(logicalBase) : 'page'
    const out = compileWxml(source, {
      file,
      components: Object.keys(using),
      where,
      rootTag: `wx-${host}`,
    })
    for (const w of out.warnings) ctx.warn(w)

    const scopeId = scopeIdOf(logicalBase)
    const tpl = compileTemplate({
      source: out.template,
      filename: file,
      id: scopeId,
      scoped: true,
      compilerOptions: {
        isCustomElement: (t) => t.startsWith('wx-'),
        whitespace: 'condense',
        comments: false,
        delimiters: DELIMITERS,
      },
    })
    if (tpl.errors && tpl.errors.length) {
      const msg = tpl.errors.map((e) => (typeof e === 'string' ? e : e.message)).join('\n')
      throw new Error(`${where} 编译失败：\n${msg}`)
    }

    const imports = []
    const wxsEntries = out.wxs.map((w, i) => {
      const target = resolveWxsPath(logicalBase, w.src)
      if (!existsLogical(target)) throw new Error(`${where}：找不到 wxs ${w.src}`)
      imports.push(`import __wxs${i} from ${JSON.stringify(`${toPosix(physical(target))}?mp-wxs`)};`)
      return `${JSON.stringify(w.module)}: __wxs${i}`
    })
    const compEntries = []
    for (const tag of out.usedComponents) {
      const compBase = resolveComponentPath(using[tag], logicalBase)
      if (compBase === logicalBase) continue
      const i = compEntries.length
      imports.push(`import __comp${i} from ${JSON.stringify(`${toPosix(physical(`${compBase}.wxml`))}?mp-comp`)};`)
      compEntries.push(`${JSON.stringify(tag)}: __comp${i}`)
    }
    return { out, json, host, scopeId, code: tpl.code, imports, wxsEntries, compEntries }
  }

  function genView(ctx, file, kind) {
    const logicalBase = logicalOf(file).replace(/\.wxml$/, '')
    const where = `miniprogram/${logicalBase}.wxml`
    const v = compileView(ctx, { source: readLogical(`${logicalBase}.wxml`), file, logicalBase, kind, where })

    const jsLogical = `${logicalBase}.js`
    if (!existsLogical(jsLogical)) throw new Error(`${where}：缺少同名 .js`)
    const imports = []
    const runtimeEntry = kind === 'page' ? 'page.js' : 'component.js'
    imports.push(`import { ${kind === 'page' ? 'definePage' : 'defineMpComponent'} as __define } from ${JSON.stringify(toPosix(path.join(RUNTIME_ROOT, runtimeEntry)))};`)
    imports.push(`import * as __mpScript from ${JSON.stringify(toPosix(physical(jsLogical)))};`)
    imports.push(...v.imports)
    if (existsLogical(`${logicalBase}.wxss`) || fs.existsSync(path.join(DESKTOP_ROOT, `${logicalBase}.wxss`))) {
      imports.push(`import ${JSON.stringify(cssId(`${logicalBase}.wxss`, false))};`)
    }

    // 电脑版：src/desktop/ 下同路径的 .wxml（模板）和 .desktop.js（只在电脑版用的数据和方法）
    let desktop = 'null'
    if (kind === 'page') {
      const dkWxml = path.join(DESKTOP_ROOT, `${logicalBase}.wxml`)
      const dkJs = path.join(DESKTOP_ROOT, `${logicalBase}.desktop.js`)
      const parts = []
      if (fs.existsSync(dkWxml)) {
        imports.push(`import * as __dkView from ${JSON.stringify(`${toPosix(dkWxml)}?mp-desktop`)};`)
        parts.push('view: __dkView')
      }
      if (fs.existsSync(dkJs)) {
        imports.push(`import __dkMixin from ${JSON.stringify(toPosix(dkJs))};`)
        parts.push('mixin: __dkMixin')
      }
      if (parts.length) desktop = `{ ${parts.join(', ')} }`
    }

    const meta = {
      route: logicalBase,
      scopeId: v.scopeId,
      host: v.host,
      dataKeys: v.out.dataKeys,
      json: {
        navigationBarTitleText: v.json.navigationBarTitleText,
        enablePullDownRefresh: !!v.json.enablePullDownRefresh,
        onReachBottomDistance: v.json.onReachBottomDistance,
        options: v.json.options,
      },
    }
    return [
      ...imports,
      v.code,
      `export default __define({ ...${JSON.stringify(meta)}, def: __mpScript.__mp, render, wxs: { ${v.wxsEntries.join(', ')} }, components: { ${v.compEntries.join(', ')} }, desktop: ${desktop} });`,
    ].join('\n')
  }

  /** 电脑版模板：单独一个模块（和原模板各有一套 Vue 导入，放一起会重名），scope 跟页面同一个 */
  function genDesktopView(ctx, file) {
    const logicalBase = toPosix(path.relative(DESKTOP_ROOT, file)).replace(/\.wxml$/, '')
    const where = `h5/src/desktop/${logicalBase}.wxml`
    ctx.addWatchFile(file)
    const source = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
    const v = compileView(ctx, { source, file, logicalBase, kind: 'page', where })
    return [
      ...v.imports,
      v.code,
      `export const dataKeys = ${JSON.stringify(v.out.dataKeys)};`,
      `export const wxs = { ${v.wxsEntries.join(', ')} };`,
      `export const components = { ${v.compEntries.join(', ')} };`,
    ].join('\n')
  }

  function genCss(ctx, file, global) {
    const { placeholderClasses, hostOfTag } = getState()
    const logical = logicalOf(file)
    const { css, deps } = compileWxss(logical, {
      componentTags: Object.keys(hostOfTag),
      placeholderClasses,
      hostOfTag,
    })
    for (const d of deps) ctx.addWatchFile(path.isAbsolute(d) ? d : physical(d))
    if (global) return css
    const res = compileStyle({
      source: css,
      filename: file,
      id: scopeIdOf(logical.replace(/\.wxss$/, '')),
      scoped: true,
      trim: true,
    })
    if (res.errors && res.errors.length) throw new Error(`miniprogram/${logical} 样式编译失败：${res.errors[0].message}`)
    return res.code
  }

  return {
    name: 'mp-h5',
    enforce: 'pre',

    config() {
      return { server: { fs: { allow: [REPO_ROOT] } } }
    },

    configureServer(server) {
      server.watcher.add([MP_ROOT, OVERRIDE_ROOT, DESKTOP_ROOT])
      // 新加 / 删掉电脑版文件：页面模块转换时才看有没有它，要整体重编一次
      const onAddOrRemove = (file) => {
        if (!isUnder(file, DESKTOP_ROOT)) return
        state = null
        for (const [id, mod] of server.moduleGraph.idToModuleMap) {
          if (QUERY_RE.test(id)) server.moduleGraph.invalidateModule(mod)
        }
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.on('add', onAddOrRemove)
      server.watcher.on('unlink', onAddOrRemove)
    },

    resolveId(id, importer) {
      if (id === APP_ID) return RESOLVED_APP_ID
      // 电脑版 .desktop.js 直接 import miniprogram/ 下的文件：有 H5 替换件的换成替换件
      // （否则 services/request.js 会用小程序里写死的线上域名）
      if (importer && id.startsWith('.') && !id.includes('?') && isUnder(splitQuery(importer)[0], DESKTOP_ROOT)) {
        const abs = path.resolve(path.dirname(splitQuery(importer)[0]), id)
        if (isUnder(abs, MP_ROOT)) return physical(logicalOf(abs))
      }
      const [p, q] = splitQuery(id)
      if (q && QUERY_RE.test(`?${q}`) && path.isAbsolute(p)) return id
      return null
    },

    load(id) {
      if (id === RESOLVED_APP_ID) return genApp(this)
      const [file, q] = splitQuery(id)
      if (!q) return null
      const params = new URLSearchParams(q)
      if (params.has('mp-page')) return genView(this, file, 'page')
      if (params.has('mp-comp')) return genView(this, file, 'component')
      if (params.has('mp-desktop')) return genDesktopView(this, file)
      if (params.has('mp-css')) return genCss(this, file, params.has('global'))
      if (params.has('mp-wxs')) {
        this.addWatchFile(file)
        return transformCjs(fs.readFileSync(file, 'utf8'), file, getState().aliases, { wxs: true })
      }
      return null
    },

    transform(code, id) {
      const [file, q] = splitQuery(id)
      if (q || !file.endsWith('.js') || !isMpSource(file)) return null
      if (isUnder(file, DESKTOP_ROOT)) return null // 电脑版的 .desktop.js 本来就是 ESM
      return { code: transformCjs(code, file, getState().aliases), map: null }
    },

    handleHotUpdate({ file, server }) {
      if (!isMpSource(file)) return
      if (file.endsWith('.js')) return // 普通模块，走 Vite 自己的依赖图
      state = null
      resetPatches()
      for (const [id, mod] of server.moduleGraph.idToModuleMap) {
        if (id === RESOLVED_APP_ID || QUERY_RE.test(id)) server.moduleGraph.invalidateModule(mod)
      }
      server.ws.send({ type: 'full-reload' })
      return []
    },
  }
}
