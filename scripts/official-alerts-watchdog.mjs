#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'

function arg(name, fallback = null) {
  const prefix = `--${name}=`
  const found = process.argv.find(v => v.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

function readJson(path) {
  if (!path || !existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    return { __parseError: error?.message ?? String(error) }
  }
}

function parseDate(value) {
  if (!value || typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time) : null
}

function normalizeDateCandidate(value) {
  if (!value) return null
  if (typeof value === 'string') return parseDate(value)
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  return null
}

function newestAlertDate(alerts) {
  const keys = [
    'publishedAt', 'publicationDate', 'datePublished', 'createdAt', 'updatedAt',
    'date', 'alertDate', 'recallDate', 'publishedDate', 'lastModified',
  ]
  let newest = null
  for (const alert of alerts) {
    if (!alert || typeof alert !== 'object') continue
    const candidates = []
    for (const key of keys) candidates.push(alert[key])
    if (alert.raw && typeof alert.raw === 'object') {
      for (const key of keys) candidates.push(alert.raw[key])
    }
    for (const value of candidates) {
      const d = normalizeDateCandidate(value)
      if (d && (!newest || d > newest)) newest = d
    }
  }
  return newest
}

function countOf(obj) {
  if (!obj || obj.__parseError) return null
  if (Number.isInteger(obj.alertCount)) return obj.alertCount
  if (Array.isArray(obj.alerts)) return obj.alerts.length
  return null
}

function addWarning(warnings, message) {
  warnings.push(message)
  console.log(`::warning::${message}`)
}

function addNotice(message) {
  console.log(`::notice::${message}`)
}

function pctDrop(prev, current) {
  if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(current)) return null
  return Math.round(((prev - current) / prev) * 1000) / 10
}

const region = arg('region', 'UNKNOWN')
const dataPath = arg('data')
const metaPath = arg('meta')
const previousPath = arg('previous')
const previousMetaPath = arg('previous-meta')
const minCount = Number.parseInt(arg('min-count', '1'), 10)
const maxAgeHours = Number.parseInt(arg('max-age-hours', '96'), 10)
const dropWarnPercent = Number.parseInt(arg('drop-warn-percent', '25'), 10)

const warnings = []
const notes = []
const data = readJson(dataPath)
const meta = readJson(metaPath)
const previous = readJson(previousPath)
const previousMeta = readJson(previousMetaPath)

if (!dataPath) addWarning(warnings, `${region}: watchdog uruchomiony bez --data`)
if (!metaPath) addWarning(warnings, `${region}: watchdog uruchomiony bez --meta`)
if (data?.__parseError) addWarning(warnings, `${region}: nie można sparsować danych ${dataPath}: ${data.__parseError}`)
if (meta?.__parseError) addWarning(warnings, `${region}: nie można sparsować meta/manifestu ${metaPath}: ${meta.__parseError}`)
if (!data && dataPath) addWarning(warnings, `${region}: brak pliku danych ${dataPath}`)
if (!meta && metaPath) addWarning(warnings, `${region}: brak pliku meta/manifestu ${metaPath}`)

const alerts = Array.isArray(data?.alerts) ? data.alerts : []
const dataCount = countOf(data)
const metaCount = countOf(meta)
const previousCount = countOf(previous) ?? countOf(previousMeta)

if (data && !data.__parseError) {
  if (!Array.isArray(data.alerts)) addWarning(warnings, `${region}: dane nie zawierają tablicy alerts`)
  if (Number.isInteger(data.alertCount) && data.alertCount !== alerts.length) {
    addWarning(warnings, `${region}: alertCount=${data.alertCount}, ale alerts.length=${alerts.length}`)
  }
  if (Number.isInteger(minCount) && alerts.length < minCount) {
    addWarning(warnings, `${region}: podejrzanie mała liczba alertów (${alerts.length}, min=${minCount})`)
  }
}

if (dataCount !== null && metaCount !== null && dataCount !== metaCount) {
  addWarning(warnings, `${region}: licznik danych (${dataCount}) różni się od meta/manifestu (${metaCount})`)
}

if (previousCount !== null && dataCount !== null && dataCount < previousCount) {
  const drop = pctDrop(previousCount, dataCount)
  if (drop !== null && drop >= dropWarnPercent) {
    addWarning(warnings, `${region}: liczba alertów spadła z ${previousCount} do ${dataCount} (-${drop}%)`)
  } else {
    notes.push(`${region}: liczba alertów spadła z ${previousCount} do ${dataCount}, poniżej progu alarmu ${dropWarnPercent}%.`)
  }
}

const checkedAt = parseDate(meta?.lastCheckedAt) || parseDate(meta?.generatedAt) || parseDate(data?.lastCheckedAt) || parseDate(data?.generatedAt)
if (checkedAt) {
  const ageHours = (Date.now() - checkedAt.getTime()) / 36e5
  if (ageHours > maxAgeHours) {
    addWarning(warnings, `${region}: meta/manifest wygląda na starszy niż ${maxAgeHours}h (${checkedAt.toISOString()})`)
  } else {
    notes.push(`${region}: meta/manifest świeży (${checkedAt.toISOString()}).`)
  }
} else {
  addWarning(warnings, `${region}: brak poprawnej daty lastCheckedAt/generatedAt w meta lub danych`)
}

const newest = newestAlertDate(alerts)
if (newest) {
  const ageDays = (Date.now() - newest.getTime()) / 864e5
  if (ageDays > 730) {
    addWarning(warnings, `${region}: najnowsza data alertu wygląda bardzo staro (${newest.toISOString()})`)
  } else {
    notes.push(`${region}: najnowsza wykryta data alertu: ${newest.toISOString()}.`)
  }
} else if (alerts.length > 0) {
  notes.push(`${region}: nie wykryto uniwersalnego pola daty alertu; pomijam ocenę wieku najnowszego wpisu.`)
}

if (typeof meta?.hash === 'string' && meta.hash.length > 0) notes.push(`${region}: hash meta/manifestu: ${meta.hash}.`)
if (typeof meta?.generationId === 'string' && meta.generationId.length > 0) notes.push(`${region}: generationId: ${meta.generationId}.`)

if (warnings.length === 0) addNotice(`${region}: watchdog nie wykrył podejrzanych anomalii.`)

const summaryPath = process.env.GITHUB_STEP_SUMMARY
if (summaryPath) {
  const lines = []
  lines.push(`### Watchdog alertów ${region}`)
  lines.push('')
  lines.push(`- Tryb: **advisory / warning-only** — wynik nie zmienia działania aplikacji i nie blokuje publikacji.`)
  lines.push(`- Plik danych: \`${dataPath ?? 'brak'}\``)
  lines.push(`- Meta/manifest: \`${metaPath ?? 'brak'}\``)
  lines.push(`- Liczba alertów: **${dataCount ?? '?'}**`)
  if (previousCount !== null) lines.push(`- Poprzednia liczba alertów: **${previousCount}**`)
  if (checkedAt) lines.push(`- Data kontroli/generacji: **${checkedAt.toISOString()}**`)
  if (warnings.length > 0) {
    lines.push('')
    lines.push('#### Ostrzeżenia techniczne')
    for (const warning of warnings) lines.push(`- ${warning}`)
  } else {
    lines.push('')
    lines.push('Brak ostrzeżeń technicznych.')
  }
  if (notes.length > 0) {
    lines.push('')
    lines.push('#### Notatki')
    for (const note of notes) lines.push(`- ${note}`)
  }
  lines.push('')
  await import('node:fs').then(fs => fs.appendFileSync(summaryPath, `${lines.join('\n')}\n`))
}

// Warning-only by design: this watchdog never blocks publication or app behavior.
process.exit(0)
