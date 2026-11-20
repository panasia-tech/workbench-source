#!/usr/bin/env node
/**
 * 将闲鱼卖家巡航台的历史空气净化器任务统一成“品牌 + 完整型号”。
 * 只处理 category=空气净化器，且先备份原始 JSON；不会触碰显示器/手机任务。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const defaultPaths = [
  '/Users/user/Library/Application Support/闲鱼卖家巡航台/xianyu-task-center.json',
  '/Users/user/Library/Application Support/xianyu-electron/xianyu-task-center.json'
]
const inputPaths = args.includes('--all') ? defaultPaths : [valueAfter('--data-file', defaultPaths[0])]
const backupRoot = resolve(valueAfter('--backup-dir', '/Volumes/Data/行政管理/outputs/xianyu-seller-pilot-migration-backups'))
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
const backupDir = resolve(backupRoot, timestamp)
mkdirSync(backupDir, { recursive: true })

const text = (value) => String(value ?? '').trim()
const isPurifier = (task) => text(task?.category) === '空气净化器'
const isXiaomi = (task) => ['小米', '小米净化器', '小空'].includes(text(task?.brand))

function purifierModel(task) {
  const raw = text(task.model || task.name || task.keyword)
    .replace(/^小米(?:净化器)?\s*/i, '')
    .replace(/^空气净化器\s*/i, '')
    .replace(/\s+/g, '')
  if (!raw) return ''
  // 只补“代际/型号”这类明确历史任务；不要把显示器/手机型号带入净化器。
  if (/^(?:2|3|4|4LITE|4PRO|5|5S|4100|486|4PRO85|4LITE100)$/i.test(raw)) return `空气净化器${raw.toUpperCase()}`
  return `空气净化器${raw}`
}

function normalizeTask(task) {
  if (!isPurifier(task) || !isXiaomi(task)) return { task, changed: false }
  const model = purifierModel(task)
  if (!model) return { task, changed: false }
  const next = {
    ...task,
    name: `小米${model}`,
    brand: '小米',
    model,
    keyword: `小米${model}`,
    searchKeywords: [`小米${model}`]
  }
  return { task: next, changed: JSON.stringify(next) !== JSON.stringify(task) }
}

function normalizeResult(result, taskById) {
  if (!result?.taskId) return { result, changed: false }
  const task = taskById.get(text(result.taskId))
  if (!task) return { result, changed: false }
  const next = { ...result, name: task.name, brand: task.brand, model: task.model, keyword: task.keyword, searchKeywords: task.searchKeywords }
  return { result: next, changed: JSON.stringify(next) !== JSON.stringify(result) }
}

const report = []
for (const [sourceIndex, source] of inputPaths.entries()) {
  if (!existsSync(source)) {
    report.push({ source, ok: false, reason: '文件不存在' })
    continue
  }
  const backup = resolve(backupDir, `${String(sourceIndex + 1).padStart(2, '0')}-${basename(source)}.bak`)
  copyFileSync(source, backup)
  const data = JSON.parse(readFileSync(source, 'utf8'))
  let taskCount = 0
  let resultCount = 0
  const collections = (Array.isArray(data.collections) ? data.collections : []).map((collection) => {
    const tasks = (Array.isArray(collection.tasks) ? collection.tasks : []).map((task) => {
      const normalized = normalizeTask(task)
      if (normalized.changed) taskCount++
      return normalized.task
    })
    return { ...collection, tasks }
  })
  const taskById = new Map(collections.flatMap((collection) => collection.tasks || []).map((task) => [text(task.id), task]))
  const runResults = (Array.isArray(data.runResults) ? data.runResults : []).map((result) => {
    const normalized = normalizeResult(result, taskById)
    if (normalized.changed) resultCount++
    return normalized.result
  })
  const next = { ...data, collections, runResults }
  const temp = `${source}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  // rename is atomic on the same volume and leaves the backup above as recovery point.
  const { renameSync } = await import('node:fs')
  renameSync(temp, source)
  report.push({ source, backup, ok: true, taskCount, resultCount })
}

writeFileSync(resolve(backupDir, 'report.json'), `${JSON.stringify({ timestamp, report }, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ backupDir, report }, null, 2))
