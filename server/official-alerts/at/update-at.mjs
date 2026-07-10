#!/usr/bin/env node
/**
 * server/official-alerts/at/update-at.mjs — pipeline danych urzędowych AT (Austria).
 *
 * Pobiera oficjalne alerty żywnościowe AGES (Agentur für Gesundheit und
 * Ernährungssicherheit) z portalu ages.at.
 *
 * AGES nie udostępnia API ani RSS — wyłącznie HTML scraping (TYPO3 CMS):
 *   1. Strona kategorii Lebensmittel (cat=8) — paginacja ze dynamicznym cHash
 *      Strona 1 ma stabilny URL (cHash dla cat=8 bez page param).
 *      Kolejne strony są wykrywane dynamicznie z linków paginacji.
 *   2. Strony szczegółowe nowych alertów (throttle 2000 ms)
 *
 * Uwaga: cHash w TYPO3 jest wyznaczany z parametrów + server-side secret.
 * Jeśli CATEGORY_URL_PAGE1 zwróci 0 wyników, możliwa zmiana instalacji TYPO3
 * — zaktualizuj stałą CATEGORY_URL_PAGE1 (pobierz nowy URL z ages.at).
 *
 * Wynik (Architecture A — jak DE/FR/NL/GIS/ES):
 *   public/at-alerts.json       — baza alertów AT
 *   public/at-alerts-meta.json  — meta plik do conditional fetch
 *
 * Użycie:
 *   node server/official-alerts/at/update-at.mjs
 *   node server/official-alerts/at/update-at.mjs --dry-run
 *   node server/official-alerts/at/update-at.mjs --backfill
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { createHash } from 'crypto'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_OUTPUT_PATH = join(__dir, '../../../public/at-alerts.json')
const META_OUTPUT_PATH = join(__dir, '../../../public/at-alerts-meta.json')

// ── Stałe ─────────────────────────────────────────────────────────────────────

const REGION            = 'AT'
const PROVIDER_ID       = 'AT_AGES'
const SOURCE_NAME       = 'AGES (Agentur für Gesundheit und Ernährungssicherheit)'
const BASE_URL          = 'https://www.ages.at'
const OFFICIAL_HOSTNAME = 'www.ages.at'
const PRODUCT_PATH      = '/mensch/produktwarnungen-produktrueckrufe/produkt/'

// Strona 1 kategorii Lebensmittel (cat=8). cHash jest stabilny dla tego
// zestawu parametrów dopóki TYPO3 nie zmieni sekretu hashującego.
// Jeśli scraper zwróci 0 alertów — zaktualizuj ten URL.
const CATEGORY_URL_PAGE1 = 'https://www.ages.at/mensch/produktwarnungen-produktrueckrufe?tx_agesrecall_pi1%5Bcat%5D=8&cHash=b220fb2a107682df91cd9b410621f748'

// AGES Lebensmittel: ~60–120 aktywnych alertów. Progi bezpieczeństwa:
const OBSERVATION_THRESHOLD = 20   // warn gdy mniej
const SAFETY_THRESHOLD      = 500  // error gdy więcej — prawdopodobny błąd
const MAX_AGE_DAYS          = 730  // alerty starsze niż 2 lata są usuwane
const REQUEST_DELAY_MS      = 2000 // crawl throttle
const MAX_PAGES             = 50   // bezpieczny limit paginacji

// ── Argumenty CLI ─────────────────────────────────────────────────────────────

const DRY_RUN  = process.argv.includes('--dry-run')
const BACKFILL = process.argv.includes('--backfill')

// ── Pomocnicze narzędzia ───────────────────────────────────────────────────────

function log(...args)  { console.log('[AT]', ...args) }
function warn(...args) { console.warn('[AT] WARN:', ...args) }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchWithTimeout(url, timeoutMs = 30_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BezpiecznyKoszyk/1.0; food-safety-monitor)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-AT,de;q=0.9,en;q=0.5',
      },
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timeout po ${timeoutMs}ms dla: ${url}`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ── Parsowanie dat (format AGES: "03.07.2026" lub "3. Juli 2026") ─────────────

const GERMAN_MONTHS = {
  januar: '01', februar: '02', märz: '03', april: '04',
  mai: '05', juni: '06', juli: '07', august: '08',
  september: '09', oktober: '10', november: '11', dezember: '12',
}

function parseGermanDate(text) {
  if (!text) return null
  // Format: "03.07.2026" lub "3.7.2026"
  const m1 = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/)
  if (m1) return `${m1[3]}-${m1[2].padStart(2, '0')}-${m1[1].padStart(2, '0')}`
  // Format: "3. Juli 2026"
  const m2 = text.match(/(\d{1,2})\.\s*([A-Za-zä]+)\s+(\d{4})/)
  if (m2) {
    const monthNum = GERMAN_MONTHS[m2[2].toLowerCase()]
    if (monthNum) return `${m2[3]}-${monthNum}-${m2[1].padStart(2, '0')}`
  }
  return null
}

// ── Stripping HTML ────────────────────────────────────────────────────────────

const HTML_ENTITY_MAP = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ',
  '&auml;': 'ä', '&ouml;': 'ö', '&uuml;': 'ü',
  '&Auml;': 'Ä', '&Ouml;': 'Ö', '&Uuml;': 'Ü',
  '&szlig;': 'ß', '&ndash;': '–', '&mdash;': '—',
  '&laquo;': '«', '&raquo;': '»', '&hellip;': '...',
  '&euro;': '€',
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|ul|ol|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, s => HTML_ENTITY_MAP[s] ?? ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Klasyfikacja zagrożenia (język niemiecki) ──────────────────────────────────

const HAZARD_PATTERNS = [
  [
    /fremdkörper|metallspäne|glassplitter|kunststoffteil|metallpartikel|knochenfragment|holzsplitter|fremdstoff|fremdbestandteil|kunststofffremdkörper|fremdpartikel/i,
    'physical',
  ],
  [
    /salmonell|listerien|listeria|e\.?\s*coli|campylobacter|stec|shiga|clostridium|bacillus\s+cereus|histamin|norovirus|hepatitis|yersin|rotavirus|schimmelpizcpilz|schimmelpilz|mykotoxin|toxin|aflatoxin/i,
    'microbiological',
  ],
  [
    /allergen|gluten|weizen\s+(?:nicht|ohne)\s+deklariert|milch\s+(?:nicht|ohne)\s+deklariert|laktose\s+(?:nicht|ohne)\s+deklariert|soja\s+(?:nicht|ohne)\s+deklariert|erdnuss|nüsse\s+(?:nicht|ohne)\s+deklariert|sellerie|sesam\s+(?:nicht|ohne)\s+deklariert|senf\s+(?:nicht|ohne)\s+deklariert|sulfite|sulfit|eier\s+(?:nicht|ohne)\s+deklariert|fisch\s+(?:nicht|ohne)\s+deklariert|krebstiere|weichtiere|schalentiere|lupinen|mandeln|haselnüsse|walnüsse|nicht\s+(?:auf|im)\s+etikett|undeklariert/i,
    'allergen',
  ],
  [
    /pestizid|pflanzenschutzmittel|schwermetall|blei|cadmium|quecksilber|arsen|dioxin|pcb|aflatoxin|ochratoxin|patulin|mykotoxin|ethylenoxid|chlorat|perchlorat|nitrat|nitrit|benzo|acrylamid|herbizid|fungizid|insektizid|rückstand|schadstoff/i,
    'chemical',
  ],
  [
    /kennzeichnung|etikettierung|fehlkennzeichnung|falsche\s+bezeichnung|falsche\s+kennzeichnung|mindesthaltbarkeit\s+fehlt|fehlende\s+angabe|falsche\s+angabe|unvollständige\s+kennzeichnung/i,
    'labelling',
  ],
]

function classifyHazardType(text) {
  for (const [re, type] of HAZARD_PATTERNS) {
    if (re.test(text)) return type
  }
  return 'other'
}

function extractHazardDescription(title) {
  if (!title) return null
  // "Rückruf wegen Salmonellen in XY" → "Salmonellen"
  const m1 = title.match(/wegen\s+(.+?)\s+in\s+/i)
  if (m1) return m1[1].replace(/\s+/g, ' ').trim()
  // "Rückruf: Salmonellen in XY"
  const m2 = title.match(/(?:Rückruf|Warnung)[:\s–-]+(.+?)(?:\s+in\s+|\s*$)/i)
  if (m2) return m2[1].replace(/\s+/g, ' ').trim().slice(0, 80)
  return null
}

// ── Parsowanie strony kategorii (listado) ─────────────────────────────────────

/** Wyodrębnia slug z href AGES: "/mensch/.../produkt/[slug]" → "[slug]" */
function extractSlugFromHref(href) {
  const m = href.match(/\/produkt\/([^/?#]+)/)
  return m ? m[1] : null
}

function buildAlertId(slug) {
  return `at-${slug}`
}

/**
 * Parsuje stronę listinową AGES — wyodrębnia:
 * - linki do alertów (ścieżki /produkt/[slug])
 * - link do następnej strony paginacji (z wbudowanym cHash)
 *
 * TYPO3 AGES używa klas CSS:
 *   <a href="/mensch/.../produkt/[slug]" class="...">Tytuł</a>
 * lub bezpośrednio linki w liście.
 */
function parseCategoryPage(html, currentPageUrl) {
  const items = []
  const seenSlugs = new Set()

  // Znajdź linki do alertów (prefix /mensch/produktwarnungen-produktrueckrufe/produkt/)
  const PRODUCT_LINK_RE = new RegExp(
    `href="(${PRODUCT_PATH.replace(/\//g, '\\/')}([^"?#]+))"`,
    'gi'
  )

  let m
  while ((m = PRODUCT_LINK_RE.exec(html)) !== null) {
    const href = m[1]
    const slug = m[2]
    if (!slug || seenSlugs.has(slug)) continue
    seenSlugs.add(slug)

    // Znajdź tekst anchra jako tytuł (do 200 znaków po href, aż do </a>)
    const afterHref = html.indexOf('>', m.index)
    const closeA = html.indexOf('</a>', afterHref)
    const title = afterHref !== -1 && closeA !== -1
      ? stripHtml(html.slice(afterHref + 1, closeA)).replace(/\s+/g, ' ').trim()
      : null

    // Szukaj daty w okolicach linka (±150 znaków)
    const context = html.slice(Math.max(0, m.index - 50), m.index + 300)
    const date = parseGermanDate(context)

    items.push({
      slug,
      href,
      fullUrl: `${BASE_URL}${href}`,
      title:   title || null,
      date:    date || null,
    })
  }

  // Znajdź link do następnej strony paginacji
  // TYPO3: href="...?tx_agesrecall_pi1%5Bcat%5D=8&tx_agesrecall_pi1%5Bpage%5D=N&cHash=..."
  const NEXT_PAGE_RE = /href="([^"]*tx_agesrecall_pi1%5Bcat%5D=8[^"]*tx_agesrecall_pi1%5Bpage%5D=(\d+)[^"]*cHash=[^"]*)"/gi
  let nextPageUrl = null
  let maxPageNum = 0

  // Wyciągnij aktualny numer strony z URL
  const currentPageM = currentPageUrl.match(/tx_agesrecall_pi1%5Bpage%5D=(\d+)/)
  const currentPage = currentPageM ? parseInt(currentPageM[1], 10) : 1

  while ((m = NEXT_PAGE_RE.exec(html)) !== null) {
    const pageNum = parseInt(m[2], 10)
    if (pageNum > currentPage && pageNum > maxPageNum) {
      maxPageNum = pageNum
      nextPageUrl = `${BASE_URL}${m[1].replace(/&amp;/g, '&')}`
    }
  }

  // Fallback: szukaj także kodowanego ampersanda w href
  if (!nextPageUrl) {
    const NEXT_PAGE_RE2 = /href="([^"]*tx_agesrecall_pi1\[cat\]=8[^"]*tx_agesrecall_pi1\[page\]=(\d+)[^"]*)"/gi
    while ((m = NEXT_PAGE_RE2.exec(html)) !== null) {
      const pageNum = parseInt(m[2], 10)
      if (pageNum > currentPage && pageNum > maxPageNum) {
        maxPageNum = pageNum
        nextPageUrl = `${BASE_URL}${m[1].replace(/&amp;/g, '&')}`
      }
    }
  }

  return { items, nextPageUrl }
}

// ── Parsowanie strony szczegółowej alertu ─────────────────────────────────────

function extractField(plaintext, ...labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^\\s*${escaped}\\s*:?\\s*(.{2,200})`, 'im')
    const m = plaintext.match(re)
    if (!m) continue
    const value = m[1].split('\n')[0].trim()
    if (value.length >= 2 && value.length <= 200) return value
  }
  return null
}

function extractPageTitle(html) {
  const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  if (h1M) return stripHtml(h1M[1]).replace(/\s+/g, ' ').trim()
  const h2M = html.match(/<h2[^>]*class="[^"]*(?:recall|warning|headline)[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)
  if (h2M) return stripHtml(h2M[1]).replace(/\s+/g, ' ').trim()
  const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (titleM) return titleM[1].replace(/\s+/g, ' ').replace(/\s*[|\-–]\s*AGES.*$/i, '').trim()
  return null
}

function parseAgesAlertPage(html, listingTitle) {
  const text = stripHtml(html)

  const productName = extractField(text,
    'Produkt',
    'Produktname',
    'Produktbezeichnung',
    'Bezeichnung des Erzeugnisses',
    'Bezeichnung',
  )

  const brand = extractField(text,
    'Hersteller',
    'Importeur',
    'Inverkehrbringer',
    'Marke',
    'Firma',
  )

  // Batch: numer partii lub MHD (często jedno pole łączone)
  const batchRaw = extractField(text,
    'Chargennummer',
    'Chargenbezeichnung',
    'Losnummer',
    'Los-Nummer',
    'Mindesthaltbarkeitsdatum (MHD)',
    'Mindesthaltbarkeitsdatum',
    'MHD',
    'Haltbar bis',
    'Verfallsdatum',
    'Charge',
  )
  const batchNumbers = batchRaw ? [batchRaw] : []

  // Data publikacji ze strony szczegółowej
  const dateRaw = extractField(text,
    'Veröffentlicht am',
    'Datum',
    'Veröffentlichungsdatum',
    'Meldedatum',
  )
  const parsedDate = parseGermanDate(dateRaw ?? '')

  const pageHeading = extractPageTitle(html)
  const titleForClassify = listingTitle || pageHeading || ''
  const hazardType        = classifyHazardType(titleForClassify + ' ' + text.slice(0, 500))
  const hazardDescription = extractHazardDescription(titleForClassify)

  return {
    productName:       productName ?? null,
    brand:             brand ?? null,
    batchNumbers,
    hazardType,
    hazardDescription: hazardDescription ?? null,
    pageHeading,
    parsedDate,
  }
}

// ── Wczytywanie / zapis datasetu ─────────────────────────────────────────────

function loadExistingDataset() {
  if (!existsSync(DATA_OUTPUT_PATH)) return { alerts: [] }
  try {
    return JSON.parse(readFileSync(DATA_OUTPUT_PATH, 'utf8'))
  } catch {
    warn('Nie można wczytać istniejącego datasetu — zaczynam od zera')
    return { alerts: [] }
  }
}

function computeContentHash(alerts) {
  const canonical = JSON.stringify(
    [...alerts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, eans, batchNumbers, publishedAt, sourceUrl }) =>
        ({ id, eans, batchNumbers, publishedAt, sourceUrl }))
  )
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

// ── Walidacja datasetu ────────────────────────────────────────────────────────

export function validateAtAlertsDataset(dataset, { previousAlertCount } = {}) {
  const errors   = []
  const warnings = []

  if (dataset.region !== REGION)
    errors.push(`Zły region: ${dataset.region} (oczekiwano ${REGION})`)
  if (!Array.isArray(dataset.alerts)) {
    errors.push('Brak tablicy alerts')
    return { valid: false, errors, warnings }
  }
  if (dataset.providerId !== PROVIDER_ID)
    errors.push(`Zły providerId: ${dataset.providerId}`)

  const count = dataset.alerts.length
  if (count > SAFETY_THRESHOLD)
    errors.push(`Za dużo alertów: ${count} > ${SAFETY_THRESHOLD} — prawdopodobny błąd parsowania`)
  if (count < OBSERVATION_THRESHOLD)
    warnings.push(`Mała liczba alertów: ${count} < ${OBSERVATION_THRESHOLD} — sprawdź scraper lub CATEGORY_URL_PAGE1`)

  if (previousAlertCount != null) {
    const drop = previousAlertCount - count
    if (drop > 15)
      warnings.push(`Duży spadek: ${previousAlertCount} → ${count} (−${drop} alertów)`)
  }

  const seenIds  = new Set()
  const seenUrls = new Set()
  for (const a of dataset.alerts) {
    if (!a.id)
      errors.push(`Alert bez id: ${JSON.stringify(a).slice(0, 80)}`)
    if (seenIds.has(a.id))
      errors.push(`Duplikat id: ${a.id}`)
    seenIds.add(a.id)

    if (!a.sourceUrl?.includes(OFFICIAL_HOSTNAME))
      errors.push(`Nieoficjalny sourceUrl: ${a.sourceUrl ?? 'null'} (id: ${a.id})`)
    if (seenUrls.has(a.sourceUrl))
      warnings.push(`Duplikat sourceUrl: ${a.sourceUrl}`)
    seenUrls.add(a.sourceUrl)

    if (a.region !== REGION)
      errors.push(`Alert z błędnym regionem: ${a.region} (id: ${a.id})`)
    if (!Array.isArray(a.eans))
      errors.push(`Brak tablicy eans (id: ${a.id})`)
    if (!Array.isArray(a.batchNumbers))
      errors.push(`Brak tablicy batchNumbers (id: ${a.id})`)
  }

  return { valid: errors.length === 0, errors, warnings }
}

// ── Główny pipeline ───────────────────────────────────────────────────────────

async function main() {
  log(`START — ${new Date().toISOString()} | dry-run=${DRY_RUN} | backfill=${BACKFILL}`)

  // 1. Wczytaj istniejący dataset + wyfiltruj stare alerty
  const existing      = loadExistingDataset()
  const cutoffDate    = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10)
  const freshExisting = (existing.alerts ?? []).filter(a =>
    !a.publishedAt || a.publishedAt >= cutoffDate
  )
  const evictedCount  = (existing.alerts ?? []).length - freshExisting.length
  if (evictedCount > 0)
    log(`Usunięto ${evictedCount} alertów starszych niż ${MAX_AGE_DAYS} dni`)

  const existingByUrl = new Set(freshExisting.map(a => a.sourceUrl))
  log(`Aktywne alerty w bazie: ${freshExisting.length}`)

  // 2. Pobierz wszystkie linki do alertów przez paginację
  log(`Pobieranie listy alertów AGES (Lebensmittel, cat=8)...`)
  const allItems = []
  let nextUrl = CATEGORY_URL_PAGE1
  let pageCount = 0

  while (nextUrl && pageCount < MAX_PAGES) {
    pageCount++
    log(`  Strona ${pageCount}: ${nextUrl.slice(0, 100)}`)

    if (pageCount > 1) await sleep(REQUEST_DELAY_MS)

    let res
    try {
      res = await fetchWithTimeout(nextUrl, 30_000)
    } catch (err) {
      warn(`Błąd sieci pobierając stronę ${pageCount}: ${err.message}`)
      break
    }

    if (!res.ok) {
      warn(`Błąd HTTP ${res.status} dla strony ${pageCount}`)
      break
    }

    const { items, nextPageUrl } = parseCategoryPage(res.text, nextUrl)
    log(`    Znaleziono ${items.length} alertów, nextPage=${nextPageUrl ? 'tak' : 'nie'}`)

    allItems.push(...items)
    nextUrl = nextPageUrl
  }

  // Deduplikacja po slug (różne strony mogą mieć to samo)
  const seenSlugs  = new Map()
  for (const item of allItems) {
    if (!seenSlugs.has(item.slug)) seenSlugs.set(item.slug, item)
  }
  const uniqueItems = [...seenSlugs.values()]
  log(`Łącznie: ${allItems.length} wpisów → ${uniqueItems.length} unikalne (${pageCount} stron)`)

  if (uniqueItems.length === 0) {
    throw new Error(
      'Scraper zwrócił 0 alertów — prawdopodobna zmiana struktury AGES lub wygaśnięcie cHash.\n' +
      'Sprawdź CATEGORY_URL_PAGE1 w update-at.mjs.'
    )
  }

  // 3. Wybierz do pobrania: nowe lub wszystkie (--backfill)
  const toFetch = BACKFILL
    ? uniqueItems
    : uniqueItems.filter(e => !existingByUrl.has(e.fullUrl))
  log(`Do pobrania stron szczegółowych: ${toFetch.length}`)

  if (toFetch.length === 0 && evictedCount === 0) {
    log('Brak nowych alertów — dataset jest aktualny.')
    if (!DRY_RUN) {
      const meta = existsSync(META_OUTPUT_PATH)
        ? JSON.parse(readFileSync(META_OUTPUT_PATH, 'utf8'))
        : {}
      meta.lastCheckedAt = new Date().toISOString()
      writeFileSync(META_OUTPUT_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf8')
    }
    return
  }

  // 4. Pobierz i parsuj strony szczegółowe nowych alertów
  const newAlerts   = []
  let skippedErrors = 0

  for (let i = 0; i < toFetch.length; i++) {
    const entry = toFetch[i]
    log(`[${i + 1}/${toFetch.length}] ${entry.slug}: ${(entry.title ?? '').slice(0, 60)}`)

    if (i > 0) await sleep(REQUEST_DELAY_MS)

    let res
    try {
      res = await fetchWithTimeout(entry.fullUrl, 30_000)
    } catch (err) {
      warn(`Błąd sieci dla ${entry.fullUrl}: ${err.message}`)
      skippedErrors++
      continue
    }

    if (!res.ok) {
      warn(`Błąd HTTP ${res.status} dla: ${entry.fullUrl}`)
      skippedErrors++
      continue
    }

    const top = res.text.slice(0, 500)
    if (!/<html[\s>]/i.test(top) && !/<!doctype/i.test(top)) {
      warn(`Nie-HTML odpowiedź dla: ${entry.fullUrl}`)
      skippedErrors++
      continue
    }

    const pageData = parseAgesAlertPage(res.text, entry.title)
    const publishedAt = entry.date ?? pageData.parsedDate ?? null

    const alert = {
      id:                buildAlertId(entry.slug),
      title:             entry.title || pageData.pageHeading || null,
      productName:       pageData.productName,
      brand:             pageData.brand,
      hazardType:        pageData.hazardType,
      hazardDescription: pageData.hazardDescription,
      batchNumbers:      pageData.batchNumbers,
      eans:              [],  // AGES nie podaje kodów EAN/GTIN
      publishedAt,
      sourceUrl:         entry.fullUrl,
      source:            'ages.at',
      region:            REGION,
      foodCategory:      'food',
    }

    newAlerts.push(alert)
    log(`  → hazard: ${alert.hazardType} | produkt: ${alert.productName ?? '(brak)'} | loty: ${alert.batchNumbers.length}`)
  }

  log(`Nowe alerty: ${newAlerts.length} | błędy: ${skippedErrors}`)

  if (newAlerts.length === 0 && evictedCount === 0) {
    log('Żadnych nowych alertów do zapisania.')
    return
  }

  // 5. Połącz z istniejącymi, deduplikuj po ID, sortuj
  const alertsById = new Map()
  for (const a of freshExisting) alertsById.set(a.id, a)
  for (const a of newAlerts)     alertsById.set(a.id, a)
  const allAlerts = [...alertsById.values()]
    .sort((a, b) => (b.publishedAt ?? '0').localeCompare(a.publishedAt ?? '0'))

  const now         = new Date().toISOString()
  const contentHash = computeContentHash(allAlerts)

  const dataset = {
    region:      REGION,
    version:     '1.0',
    source:      'ages.at',
    sourceName:  SOURCE_NAME,
    sourceUrl:   CATEGORY_URL_PAGE1,
    providerId:  PROVIDER_ID,
    generatedAt: now,
    updatedBy:   'update-at.mjs',
    alertCount:  allAlerts.length,
    alerts:      allAlerts,
  }

  const meta = {
    region:        REGION,
    hash:          contentHash,
    alertCount:    allAlerts.length,
    generatedAt:   now,
    lastCheckedAt: now,
    source:        'ages.at',
  }

  // 6. Walidacja przed zapisem
  const { valid, errors, warnings } = validateAtAlertsDataset(dataset, {
    previousAlertCount: freshExisting.length > 0 ? freshExisting.length : null,
  })
  for (const w of warnings) warn(`Walidacja: ${w}`)
  if (!valid) {
    for (const e of errors) console.error(`[AT] BŁĄD WALIDACJI: ${e}`)
    console.error('[AT] Walidacja nie przeszła — plik NIE jest zapisany.')
    process.exit(1)
  }

  if (DRY_RUN) {
    log(`DRY-RUN — nie zapisuję. Alertów: ${allAlerts.length}, hash: ${contentHash}`)
    return
  }

  // 7. Zapis
  const publicDir = join(__dir, '../../../public')
  if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true })

  writeFileSync(DATA_OUTPUT_PATH, JSON.stringify(dataset, null, 2) + '\n', 'utf8')
  writeFileSync(META_OUTPUT_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf8')

  log(`Zapisano: ${DATA_OUTPUT_PATH} (${allAlerts.length} alertów, hash: ${contentHash})`)
  log(`Zapisano: ${META_OUTPUT_PATH}`)
}

// ── Eksport do testów ─────────────────────────────────────────────────────────

export {
  parseCategoryPage,
  parseAgesAlertPage,
  classifyHazardType,
  extractHazardDescription,
  extractField,
  buildAlertId,
  parseGermanDate,
  stripHtml,
  computeContentHash,
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const _invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (_invokedDirectly) {
  main().catch(err => {
    console.error('[AT] FATAL:', err)
    process.exit(1)
  })
}
