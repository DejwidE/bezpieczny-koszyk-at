/**
 * Testy listy AGES: data publikacji, paginacja, zestawienie bazy z listą.
 *
 * Uruchomienie (bez dodatkowych pakietów):
 *   node --test server/official-alerts/at/update-at.listing.test.mjs
 *
 * `test-fixtures/ages-list-page1.html` to wycinek prawdziwej strony listy AGES
 * (3 sekcje produktów + paginacja) zapisany 2026-10-07.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseCategoryPage, reconcileExistingWithListing } from './update-at.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const PAGE1 = readFileSync(join(__dir, 'test-fixtures/ages-list-page1.html'), 'utf8')

const LIST = 'https://www.ages.at/mensch/produktwarnungen-produktrueckrufe'
const PAGE1_URL = `${LIST}?tx_agesrecall_pi1%5Bcat%5D=8&cHash=b220fb2a107682df91cd9b410621f748`
const pageUrl = n => `${LIST}?tx_agesrecall_pi1%5Bcat%5D=8&tx_agesrecall_pi1%5Bpage%5D=${n}&cHash=hash${n}`
const PRODUCT = '/mensch/produktwarnungen-produktrueckrufe/produkt/'

/** Paginacja w układzie AGES: „<", linki do WSZYSTKICH stron, „>". */
function pagination(current, total) {
  const href = n => n === 1
    ? '/mensch/produktwarnungen-produktrueckrufe?tx_agesrecall_pi1%5Bcat%5D=8&amp;cHash=b220fb2a107682df91cd9b410621f748'
    : `/mensch/produktwarnungen-produktrueckrufe?tx_agesrecall_pi1%5Bcat%5D=8&amp;tx_agesrecall_pi1%5Bpage%5D=${n}&amp;cHash=hash${n}`
  const prev = Math.max(1, current - 1)
  const next = Math.min(total, current + 1)
  let out = `<div class="pagination-holder"><ul class="pagination"><li><a href="${href(prev)}" class="previous"><</a></li>`
  for (let n = 1; n <= total; n++) out += `<li><a href="${href(n)}" title="${n}">${n}</a></li>`
  return out + `<li><a href="${href(next)}" class="next">></a></li></ul></div>`
}

function section({ slug, time, extra = '' }) {
  return `<section class="product-item"><header class="product-header"><h2>Produkt ${slug}</h2>` +
    `<p><span>Lebensmittel-Rückruf</span><span>${time ?? ''}</span></p></header>` +
    `<div class="product-info">${extra}${'<div class="product-info-row">x</div>'.repeat(40)}` +
    `<a href="${PRODUCT}${slug}" class="btn btn-primary" title="Produkt ${slug}">Details</a></div></section>`
}

// ── Data publikacji ───────────────────────────────────────────────────────────

test('prawdziwa strona: każdy wpis dostaje datę z nagłówka swojej sekcji', () => {
  const { items } = parseCategoryPage(PAGE1, PAGE1_URL)
  assert.deepEqual(
    items.map(i => [i.slug, i.date]),
    [
      ['sweet-land-veganer-fruchtgummi-sour-fruit-mix-180-g', '2026-09-30'],
      ['billa-immer-gut-aufstrich-huhn-95g', '2026-08-24'],
      ['schweinspasteten-aus-tschechien', '2026-08-06'],
    ],
  )
})

test('prawdziwa strona: termin przydatności w treści nie jest brany za datę publikacji', () => {
  assert.ok(PAGE1.includes('13.11.2028'), 'wycinek zawiera termin przydatności (Ablaufdatum)')
  const { items } = parseCategoryPage(PAGE1, PAGE1_URL)
  assert.equal(items.find(i => i.slug === 'billa-immer-gut-aufstrich-huhn-95g').date, '2026-08-24')
})

test('prawdziwa strona: tytuł i adres wpisu bez zmian', () => {
  const { items } = parseCategoryPage(PAGE1, PAGE1_URL)
  assert.equal(items[0].title, 'SWEET LAND Veganer Fruchtgummi, Sour Fruit Mix 180 g')
  assert.equal(items[0].fullUrl, `https://www.ages.at${PRODUCT}sweet-land-veganer-fruchtgummi-sour-fruit-mix-180-g`)
})

test('data następnego produktu nie przechodzi na poprzedni', () => {
  const html = section({ slug: 'a' }) + section({ slug: 'b', time: '<time datetime="05.05.2026">05.05.2026</time>' })
  const { items } = parseCategoryPage(html, PAGE1_URL)
  assert.deepEqual(items.map(i => [i.slug, i.date]), [['a', null], ['b', '2026-05-05']])
})

test('sekcja bez znacznika <time> → brak daty, nawet gdy w treści jest inna data', () => {
  const html = section({ slug: 'a', extra: '<div>Ablaufdatum</div><div>13.11.2028</div>' })
  assert.equal(parseCategoryPage(html, PAGE1_URL).items[0].date, null)
})

test('data tylko w tekście znacznika <time> (pusty atrybut) też jest odczytana', () => {
  const html = section({ slug: 'a', time: '<time datetime="">3. Juli 2026</time>' })
  assert.equal(parseCategoryPage(html, PAGE1_URL).items[0].date, '2026-07-03')
})

// ── Paginacja ────────────────────────────────────────────────────────────────

test('prawdziwa strona 1: następna jest strona 2, nie ostatnia', () => {
  const { nextPageUrl } = parseCategoryPage(PAGE1, PAGE1_URL)
  assert.match(nextPageUrl, /tx_agesrecall_pi1%5Bpage%5D=2&cHash=72e62b219b50726e186a260481384dd2$/)
  assert.ok(nextPageUrl.startsWith('https://www.ages.at/'))
  assert.ok(!nextPageUrl.includes('&amp;'))
})

test('przejście po kolei przez wszystkie strony: 1 → 2 → 3 → 4 → 5 → 6 → koniec', () => {
  const visited = [1]
  let url = PAGE1_URL
  for (let guard = 0; guard < 20; guard++) {
    const current = visited.at(-1)
    const { nextPageUrl } = parseCategoryPage(section({ slug: `p${current}` }) + pagination(current, 6), url)
    if (!nextPageUrl) break
    visited.push(Number(nextPageUrl.match(/%5Bpage%5D=(\d+)/)[1]))
    url = nextPageUrl
  }
  assert.deepEqual(visited, [1, 2, 3, 4, 5, 6])
})

test('ostatnia strona i lista jednostronicowa → brak następnej strony', () => {
  assert.equal(parseCategoryPage(section({ slug: 'a' }) + pagination(6, 6), pageUrl(6)).nextPageUrl, null)
  assert.equal(parseCategoryPage(section({ slug: 'a' }), PAGE1_URL).nextPageUrl, null)
})

// ── Zestawienie bazy z listą ─────────────────────────────────────────────────

const url = slug => `https://www.ages.at${PRODUCT}${slug}`
const alert = (slug, publishedAt = null) => ({ id: `at-${slug}`, title: slug, publishedAt, sourceUrl: url(slug) })
const listed = (slug, date) => ({ slug, fullUrl: url(slug), date })
const CUTOFF = '2024-10-07'

test('wpis bez daty dostaje datę z listy; istniejąca data nie jest nadpisywana', () => {
  const r = reconcileExistingWithListing(
    [alert('a'), alert('b', '2026-01-01')],
    [listed('a', '2026-09-30'), listed('b', '2026-02-02')],
    CUTOFF,
  )
  assert.equal(r.datesFilled, 1)
  assert.equal(r.evictedCount, 0)
  assert.deepEqual(r.freshExisting.map(a => a.publishedAt), ['2026-09-30', '2026-01-01'])
})

test('uzupełnienie daty nie zmienia pozostałych pól ani kolejności kluczy', () => {
  const before = alert('a')
  const [after] = reconcileExistingWithListing([before], [listed('a', '2026-09-30')], CUTOFF).freshExisting
  assert.deepEqual(Object.keys(after), Object.keys(before))
  assert.deepEqual({ ...after, publishedAt: null }, before)
  assert.equal(before.publishedAt, null, 'wejście nie jest modyfikowane')
})

test('wpis spoza listy bez daty zostaje bez zmian', () => {
  const r = reconcileExistingWithListing([alert('zniknal')], [listed('a', '2026-09-30')], CUTOFF)
  assert.deepEqual(r, { freshExisting: [alert('zniknal')], datesFilled: 0, evictedCount: 0 })
})

test('stary wpis nadal widoczny na liście AGES zostaje w bazie', () => {
  const r = reconcileExistingWithListing([alert('stary')], [listed('stary', '2024-08-23')], CUTOFF)
  assert.equal(r.evictedCount, 0)
  assert.equal(r.freshExisting[0].publishedAt, '2024-08-23')
})

test('stary wpis, którego AGES już nie pokazuje, jest usuwany', () => {
  const r = reconcileExistingWithListing(
    [alert('stary', '2024-08-23'), alert('swiezy', '2025-01-01')],
    [listed('inny', '2026-09-30')],
    CUTOFF,
  )
  assert.equal(r.evictedCount, 1)
  assert.deepEqual(r.freshExisting.map(a => a.id), ['at-swiezy'])
})

test('pusta baza i pusta lista nie powodują błędu', () => {
  assert.deepEqual(reconcileExistingWithListing(undefined, [], CUTOFF), { freshExisting: [], datesFilled: 0, evictedCount: 0 })
  assert.deepEqual(reconcileExistingWithListing([alert('a')], undefined, CUTOFF).datesFilled, 0)
})
