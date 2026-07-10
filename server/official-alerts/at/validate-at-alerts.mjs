#!/usr/bin/env node
/**
 * server/official-alerts/at/validate-at-alerts.mjs
 *
 * Standalone validator dla public/at-alerts.json.
 *
 * Użycie:
 *   node server/official-alerts/at/validate-at-alerts.mjs
 *   node server/official-alerts/at/validate-at-alerts.mjs --file path/to/at-alerts.json
 *   node server/official-alerts/at/validate-at-alerts.mjs --previous-count=65
 */

import { readFileSync, existsSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { validateAtAlertsDataset } from './update-at.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))

const fileArg = (() => {
  const i = process.argv.indexOf('--file')
  return i !== -1 ? process.argv[i + 1] : null
})()

const prevCountArg = (() => {
  const m = process.argv.find(a => a.startsWith('--previous-count='))
  return m ? parseInt(m.split('=')[1], 10) : null
})()

const DATA_PATH = fileArg ?? join(__dir, '../../../public/at-alerts.json')

if (!existsSync(DATA_PATH)) {
  console.error(`[AT-validate] Plik nie istnieje: ${DATA_PATH}`)
  console.error('[AT-validate] Uruchom najpierw: node server/official-alerts/at/update-at.mjs')
  process.exit(2)
}

let dataset
try {
  dataset = JSON.parse(readFileSync(DATA_PATH, 'utf8'))
} catch (err) {
  console.error(`[AT-validate] Błąd parsowania JSON: ${err.message}`)
  process.exit(2)
}

const opts = prevCountArg != null ? { previousAlertCount: prevCountArg } : {}
const { valid, errors, warnings } = validateAtAlertsDataset(dataset, opts)

for (const w of warnings) console.warn('[AT-validate] WARN:', w)
for (const e of errors)   console.error('[AT-validate] ERROR:', e)

if (valid) {
  console.log(`[AT-validate] OK — ${dataset.alertCount} alertów, region=${dataset.region}, provider=${dataset.providerId}`)
  process.exit(0)
} else {
  console.error(`[AT-validate] FAILED — ${errors.length} błąd(ów)`)
  process.exit(1)
}
