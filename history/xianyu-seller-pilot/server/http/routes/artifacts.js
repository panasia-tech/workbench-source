"use strict"

const { tokenFromRequest } = require('../events.js')

function registerArtifactRoutes(fastify, { artifacts, auth, db }) {
  fastify.get('/artifacts', async (request, reply) => {
    const actor = auth.verifyToken(tokenFromRequest(request))
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    return { artifacts: await artifacts.list(request.query?.limit) }
  })

  fastify.post('/artifacts', async (request, reply) => {
    const actor = auth.verifyToken(tokenFromRequest(request))
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    let name = 'artifact.bin'
    let mimeType = 'application/octet-stream'
    let jobId = null
    let content
    if (request.isMultipart && request.isMultipart()) {
      const file = await request.file()
      if (!file) return reply.code(400).send({ error: { code: 'file_required', message: 'A file is required' } })
      name = file.filename
      mimeType = file.mimetype
      const chunks = []
      for await (const chunk of file.file) chunks.push(chunk)
      content = Buffer.concat(chunks)
    } else {
      const body = request.body || {}
      name = body.name || name
      mimeType = body.mimeType || mimeType
      jobId = body.jobId || null
      if (body.contentBase64) content = Buffer.from(String(body.contentBase64), 'base64')
      else content = Buffer.from(String(body.content || ''), 'utf8')
    }
    const metadata = await artifacts.put({ name, mimeType, content, jobId, actorId: actor.id })
    db.audit({ actorId: actor.id, action: 'artifact.put', entityType: 'artifact', entityId: metadata.id, metadata: { size: metadata.size, jobId } })
    return reply.code(201).send({ artifact: { id: metadata.id, name: metadata.name, size: metadata.size, mimeType: metadata.mimeType, jobId } })
  })

  fastify.get('/artifacts/:id', async (request, reply) => {
    const actor = auth.verifyToken(tokenFromRequest(request))
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    try {
      const { metadata, content } = await artifacts.read(request.params.id)
      db.audit({ actorId: actor.id, action: 'artifact.read', entityType: 'artifact', entityId: metadata.id, metadata: {} })
      reply.header('content-type', 'application/octet-stream')
      const safeName = String(metadata.name || 'artifact.bin').replace(/[\r\n"\\]/g, '')
      reply.header('content-disposition', `attachment; filename="artifact.bin"; filename*=UTF-8''${encodeURIComponent(safeName)}`)
      return reply.send(content)
    } catch (error) {
      return reply.code(error.code === 'artifact_not_found' ? 404 : 400).send({ error: { code: error.code || 'artifact_read_failed', message: error.code === 'artifact_not_found' ? 'Artifact not found' : 'Artifact read failed' } })
    }
  })
}

module.exports = { registerArtifactRoutes }
