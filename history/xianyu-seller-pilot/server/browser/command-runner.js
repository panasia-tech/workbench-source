"use strict"

const { spawn } = require('node:child_process')

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT = 256 * 1024

function redactText(value, secrets = []) {
  let text = String(value == null ? '' : value)
  const candidates = Array.isArray(secrets) ? secrets : [secrets]
  for (const secret of candidates) {
    const token = String(secret || '')
    if (token.length >= 3) text = text.split(token).join('[REDACTED]')
  }
  return text
}

function boundedText(value, maxOutput) {
  const text = String(value || '')
  if (text.length <= maxOutput) return text
  return `${text.slice(0, maxOutput)}...[truncated]`
}

function runCommand(command, args = [], options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const maxOutput = Number.isFinite(options.maxOutput) ? Math.max(256, options.maxOutput) : DEFAULT_MAX_OUTPUT
  const secrets = options.secrets || []
  const signal = options.signal

  return new Promise((resolve, reject) => {
    if (!command || typeof command !== 'string') {
      reject(Object.assign(new Error('command is required'), { code: 'command_required' }))
      return
    }

    const child = spawn(command, Array.isArray(args) ? args.map(String) : [], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result)
    }
    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (stdout.length > maxOutput * 2) child.kill('SIGTERM')
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > maxOutput * 2) child.kill('SIGTERM')
    })
    child.on('error', error => {
      finish(Object.assign(new Error(redactText(error.message, secrets)), { code: 'command_spawn_failed', cause: error }))
    })
    child.on('close', (code, closeSignal) => {
      const output = {
        command: String(command),
        args: Array.isArray(args) ? args.map(value => redactText(value, secrets)) : [],
        code: Number.isInteger(code) ? code : null,
        signal: closeSignal || null,
        stdout: boundedText(redactText(stdout, secrets), maxOutput),
        stderr: boundedText(redactText(stderr, secrets), maxOutput),
        timedOut,
        aborted
      }
      if (timedOut) {
        finish(Object.assign(new Error('command timed out'), { code: 'command_timeout', result: output }))
      } else if (aborted) {
        finish(Object.assign(new Error('command aborted'), { code: 'command_aborted', result: output }))
      } else if (options.rejectOnNonZero && output.code !== 0) {
        finish(Object.assign(new Error(`command exited with code ${output.code}`), { code: 'command_failed', result: output }))
      } else {
        finish(null, output)
      }
    })
  })
}

module.exports = {
  DEFAULT_MAX_OUTPUT,
  DEFAULT_TIMEOUT_MS,
  redactText,
  runCommand
}
