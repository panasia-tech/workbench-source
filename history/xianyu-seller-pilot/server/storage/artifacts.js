"use strict"

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

function safeArtifactName(value) {
  const base = path.basename(String(value || 'artifact.bin')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
  return base || 'artifact.bin'
}

function createArtifactStore({ root, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const directory = path.resolve(String(root || path.join(process.cwd(), 'server-data', 'artifacts')))
  fs.mkdirSync(directory, { recursive: true })
  return {
    root: directory,
    async put({ name, content, mimeType = 'application/octet-stream', jobId = null, actorId = null } = {}) {
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content == null ? '' : String(content))
      if (buffer.length > maxBytes) throw Object.assign(new Error('artifact too large'), { code: 'artifact_too_large' })
      const id = crypto.randomUUID()
      const safeName = safeArtifactName(name)
      const fileName = `${id}-${safeName}`
      const target = path.join(directory, fileName)
      const temporary = `${target}.part`
      await fsp.writeFile(temporary, buffer, { flag: 'wx', mode: 0o640 })
      await fsp.rename(temporary, target)
      return { id, name: safeName, fileName, size: buffer.length, mimeType: String(mimeType).slice(0, 120), jobId: jobId ? String(jobId) : null, actorId: actorId ? String(actorId) : null }
    },
    async get(id) {
      const prefix = String(id || '').trim()
      if (!/^[a-f0-9-]{20,64}$/i.test(prefix)) throw Object.assign(new Error('invalid artifact id'), { code: 'artifact_not_found' })
      const matches = (await fsp.readdir(directory)).filter(name => name.startsWith(`${prefix}-`))
      if (!matches.length) throw Object.assign(new Error('artifact not found'), { code: 'artifact_not_found' })
      const fileName = matches[0]
      const filePath = path.join(directory, fileName)
      const stat = await fsp.stat(filePath)
      return { id: prefix, name: fileName.slice(prefix.length + 1), fileName, size: stat.size, path: filePath }
    },
    async read(id) {
      const metadata = await this.get(id)
      return { metadata, content: await fsp.readFile(metadata.path) }
    },
    async list(limit = 100) {
      const bounded = Math.min(200, Math.max(1, Number(limit) || 100))
      const files = (await fsp.readdir(directory)).filter(name => /^[a-f0-9-]{20,64}-.+/i.test(name)).slice(-bounded).reverse()
      const output = []
      for (const fileName of files) {
        const match = fileName.match(/^([a-f0-9-]{20,64})-(.+)$/i)
        if (!match) continue
        const stat = await fsp.stat(path.join(directory, fileName))
        output.push({ id: match[1], name: match[2], fileName, size: stat.size })
      }
      return output
    }
  }
}

module.exports = { DEFAULT_MAX_BYTES, createArtifactStore, safeArtifactName }
