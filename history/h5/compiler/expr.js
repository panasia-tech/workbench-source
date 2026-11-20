import { parseExpression } from '@babel/parser'

// WXML 的 {{a.b.c}} 在 a 为空时渲染空串，Vue 模板会直接抛 TypeError 把整页渲染打断。
// 所以每个成员访问 / 方法调用都改成可选链：a.b → a?.b，a[b] → a?.[b]，f.g(x) → f?.g?.(x)。
// 只插字符不重新生成代码，原表达式里的字符串、运算符原样保留。

const SKIP_KEYS = new Set([
  'type', 'start', 'end', 'loc', 'range', 'extra', 'comments',
  'leadingComments', 'trailingComments', 'innerComments',
])

function walk(node, visit, parent = null, key = '') {
  if (!node || typeof node.type !== 'string') return
  visit(node, parent, key)
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue
    const child = node[k]
    if (Array.isArray(child)) {
      for (const c of child) walk(c, visit, node, k)
    } else if (child && typeof child.type === 'string') {
      walk(child, visit, node, k)
    }
  }
}

/** 表达式里引用到的顶层变量名（a.b.c 只算 a，对象字面量的键不算） */
function collectIds(ast, out) {
  walk(ast, (node, parent, key) => {
    if (node.type !== 'Identifier') return
    if (parent && (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === 'property' && !parent.computed) return
    if (parent && parent.type === 'ObjectProperty' && key === 'key' && !parent.computed) return
    out.add(node.name)
  })
}

export function parse(code) {
  return parseExpression(code, { sourceType: 'module', errorRecovery: false })
}

export function safeExpr(src, where = '', ids = null) {
  const code = String(src).trim()
  if (!code) return 'undefined'
  let ast
  try {
    ast = parse(code)
  } catch (e) {
    throw new Error(`${where}无法解析表达式 {{${src}}}：${e.message}`)
  }
  if (ids) collectIds(ast, ids)
  const inserts = []
  walk(ast, (node) => {
    if (node.type === 'MemberExpression') {
      if (node.computed) {
        inserts.push([code.indexOf('[', node.object.end), '?.'])
      } else {
        inserts.push([code.indexOf('.', node.object.end), '?'])
      }
    } else if (node.type === 'CallExpression') {
      const callee = node.callee
      if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
        inserts.push([code.indexOf('(', callee.end), '?.'])
      }
    }
  })
  inserts.sort((a, b) => b[0] - a[0])
  let out = code
  for (const [pos, text] of inserts) {
    if (pos < 0) continue
    out = out.slice(0, pos) + text + out.slice(pos)
  }
  return out
}

/** <template is data="{{a: 1, ...b}}"> 里的对象体（不带花括号）→ 对象表达式与静态键名 */
export function templateDataExpr(inner, where = '', ids = null) {
  const code = `({${inner}})`
  let ast
  try {
    ast = parse(code)
  } catch (e) {
    throw new Error(`${where}无法解析 template data {{${inner}}}：${e.message}`)
  }
  const keys = []
  let hasSpread = false
  for (const prop of ast.properties || []) {
    if (prop.type === 'SpreadElement') {
      hasSpread = true
    } else if (!prop.computed && prop.key) {
      keys.push(prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value))
    }
  }
  return { expr: safeExpr(code, where, ids), keys, hasSpread }
}
