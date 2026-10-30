#!/usr/bin/env node
// Validates registry files and the feeds they point at, with the same rules the SnapsVault sync applies.
// Node.js 22.18 or later, built-ins only.
//
//   node scripts/validate.mjs                      every registry file
//   node scripts/validate.mjs --base origin/main   files changed since the merge base with origin/main
//   node scripts/validate.mjs <file>...            the given files
//   --root <dir>                                   the repository to check (default: the folder above this script)
//   --fetch-warnings                               feed network errors and timeouts are warnings (for runs on main)
//
// Exit code 0 when no errors were found (warnings allowed), 1 on errors, 2 on a usage or git problem.

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------------------------
// Rules shared with the app (src/lib/validation/feed.ts). Names, reasons and behaviour are
// identical; test/parity.test.mjs compares both implementations.
// ---------------------------------------------------------------------------------------------

export const MAX_URL_LENGTH = 2048
export const MAX_FEED_BYTES = 1_048_576
export const MAX_FEED_ENTRIES = 500
export const FEED_TIMEOUT_MS = 10_000

const URL_CHARS = /^[A-Za-z0-9._~:/?&=%+,@-]+$/
const URL_CHARS_WITH_FRAGMENT = /^[A-Za-z0-9._~:/?&=%+,@#-]+$/
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const TLD = /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.localdomain', '.lan', '.home.arpa']
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const SIZE = /^\d+(\.\d+)? ?(B|[KMGTP](i?B)?)$/i
const SIZE_DIGITS = /^\d{1,15}$/
const RAW_AUTHORITY = /^[A-Za-z0-9.-]+$/
const REGISTRY_FILE = /^[A-Za-z0-9._-]{1,100}\.json$/
const HEIGHT = /^\d{1,15}$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/
const SHA256 = /^[0-9a-fA-F]{64}$/
const LABEL = /^[A-Za-z0-9._-]{1,32}$/
const IDENTITY = /^[0-9A-Fa-f]{16}$/
const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/
const DISCORD = /^[A-Za-z0-9._#-]{2,40}$/
const DIR_NAME = /^[A-Za-z0-9._-]{1,64}$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
const MIN_DATE = Date.UTC(2019, 0, 1)
const ONE_DAY_MS = 24 * 60 * 60 * 1000

function fail(reason) {
  return { ok: false, reason }
}

function checkUrl(raw, allowFragment) {
  if (typeof raw !== 'string') return fail(`url is ${raw === null ? 'null' : typeof raw}, not a string`)
  if (raw.length === 0) return fail('url is empty')
  if (raw.length > MAX_URL_LENGTH) return fail(`url longer than ${MAX_URL_LENGTH} characters`)
  if (!(allowFragment ? URL_CHARS_WITH_FRAGMENT : URL_CHARS).test(raw)) return fail('url contains disallowed characters')
  if (!raw.startsWith('https://')) return fail('url does not start with https://')
  const authority = raw.slice('https://'.length).split(/[/?#]/, 1)[0]
  if (!RAW_AUTHORITY.test(authority)) return fail('url authority may only contain letters, digits, dots and hyphens')

  let url
  try {
    url = new URL(raw)
  } catch {
    return fail('url does not parse')
  }
  if (url.protocol !== 'https:') return fail(`url protocol ${url.protocol} is not https:`)
  if (url.username !== '' || url.password !== '') return fail('url contains credentials')
  if (url.port !== '') return fail('url has a non-default port')
  if (!allowFragment && url.hash !== '') return fail('url has a fragment')

  const host = url.hostname
  if (host.endsWith('.')) return fail('url host has a trailing dot')
  if (host === 'localhost') return fail('url host is localhost')
  if (BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) return fail('url host is a local or internal name')
  const labels = host.split('.')
  if (labels.length < 2) return fail('url host is not a DNS name')
  if (!labels.every(label => DNS_LABEL.test(label))) return fail('url host is not a DNS name')
  if (!TLD.test(labels[labels.length - 1])) return fail('url host is not a DNS name (IP literal or numeric TLD)')
  return { ok: true, value: url }
}

export function validateHttpsUrl(raw) {
  const r = checkUrl(raw, false)
  return r.ok ? { ok: true, value: raw } : r
}

export function validateFeedUrl(raw) {
  return validateHttpsUrl(raw)
}

export function validateContributorLink(raw) {
  const r = checkUrl(raw, true)
  return r.ok ? { ok: true, value: raw } : r
}

export function validateFilename(raw) {
  if (typeof raw !== 'string') return fail(`filename is ${raw === null ? 'null' : typeof raw}, not a string`)
  if (!FILENAME.test(raw) || raw.includes('..')) return fail('filename has a disallowed form')
  return { ok: true, value: raw }
}

export function safeFilenameFromUrl(url) {
  const r = checkUrl(url, false)
  if (!r.ok) return null
  const segment = r.value.pathname.split('/').pop() || ''
  const f = validateFilename(segment)
  return f.ok ? f.value : null
}

export function validateRegistryFileName(raw) {
  if (typeof raw !== 'string' || !REGISTRY_FILE.test(raw) || /^\.+$/.test(raw.slice(0, -'.json'.length))) {
    return fail('registry file name has a disallowed form')
  }
  return { ok: true, value: raw }
}

export function validateDirectoryName(raw) {
  if (typeof raw !== 'string' || !DIR_NAME.test(raw)) return fail('directory name has a disallowed form')
  return { ok: true, value: raw }
}

function isPresent(v) {
  return v !== undefined && v !== null && v !== ''
}

function checkSize(v) {
  if (typeof v === 'number') {
    return Number.isFinite(v) && v > 0 ? { ok: true, value: v } : fail('size is not a positive finite number')
  }
  if (typeof v === 'string' && v.length <= 24 && (SIZE.test(v) || SIZE_DIGITS.test(v))) {
    return parseFloat(v) > 0 ? { ok: true, value: v } : fail('size is not a positive value')
  }
  return fail('size has a disallowed form')
}

function checkHeight(v, field) {
  if (typeof v === 'number') {
    return Number.isSafeInteger(v) && v >= 0 ? { ok: true, value: v } : fail(`${field} is not a safe non-negative integer`)
  }
  if (typeof v === 'string' && HEIGHT.test(v)) return { ok: true, value: Number(v) }
  return fail(`${field} has a disallowed form`)
}

function checkDate(v, field, now) {
  const m = typeof v === 'string' ? ISO_DATE.exec(v) : null
  if (typeof v !== 'string' || !m) return fail(`${field} is not an ISO 8601 date with a timezone`)
  const t = new Date(v).getTime()
  if (Number.isNaN(t)) return fail(`${field} is not a valid date`)
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[7] ?? '0'].map(Number)
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, sec))
  if (wall.getUTCFullYear() !== y || wall.getUTCMonth() !== mo - 1 || wall.getUTCDate() !== d ||
      wall.getUTCHours() !== h || wall.getUTCMinutes() !== mi || wall.getUTCSeconds() !== sec) {
    return fail(`${field} is not a real calendar date and time`)
  }
  if (t > now + ONE_DAY_MS) return fail(`${field} is in the future`)
  if (t < MIN_DATE) return fail(`${field} is before 2019-01-01`)
  return { ok: true, value: v }
}

function checkSha(v, field) {
  if (typeof v !== 'string' || !SHA256.test(v)) return fail(`${field} is not 64 hex characters`)
  return { ok: true, value: v.toLowerCase() }
}

function checkLabel(v, field) {
  if (typeof v !== 'string' || !LABEL.test(v)) return fail(`${field} has a disallowed form`)
  return { ok: true, value: v }
}

function checkTxIndex(v) {
  if (typeof v === 'boolean' || v === 'true' || v === 'false') return { ok: true, value: v }
  return fail('tx_index is not a boolean or "true"/"false"')
}

export function validateSnapshotEntry(raw, now = Date.now()) {
  const reject = (reason, value) => ({ ok: false, reason, value })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return reject('entry is not an object', raw)
  const e = raw

  const rawUrl = isPresent(e.url) ? e.url : e.download_url
  if (!isPresent(rawUrl)) return reject('url is missing', raw)
  const url = validateHttpsUrl(rawUrl)
  if (!url.ok) return reject(url.reason, rawUrl)

  let filename
  if (isPresent(e.filename)) {
    const f = validateFilename(e.filename)
    if (!f.ok) return reject(f.reason, e.filename)
    filename = f.value
  } else {
    const derived = safeFilenameFromUrl(url.value)
    if (!derived) return reject('no valid filename in url path', url.value)
    filename = derived
  }

  const entry = { url: url.value, filename }

  if (isPresent(e.size)) {
    const s = checkSize(e.size)
    if (!s.ok) return reject(s.reason, e.size)
    entry.size = s.value
  }

  let height
  for (const field of ['latest_block_height', 'block_height', 'height']) {
    if (!isPresent(e[field])) continue
    const h = checkHeight(e[field], field)
    if (!h.ok) return reject(h.reason, e[field])
    height = height !== undefined ? height : h.value
  }
  if (height !== undefined) entry.latest_block_height = height

  let date
  for (const field of ['creation_date', 'time']) {
    if (!isPresent(e[field])) continue
    const d = checkDate(e[field], field, now)
    if (!d.ok) return reject(d.reason, e[field])
    date = date || d.value
  }
  if (date) entry.creation_date = date

  let sha
  if (isPresent(e.sha256sum)) {
    const s = checkSha(e.sha256sum, 'sha256sum')
    if (!s.ok) return reject(s.reason, e.sha256sum)
    sha = s.value
  }
  if (isPresent(e.checksum)) {
    const c = e.checksum
    if (typeof c !== 'object' || Array.isArray(c)) return reject('checksum is not an object', c)
    const legacy = c.sha256
    if (isPresent(legacy)) {
      const s = checkSha(legacy, 'checksum.sha256')
      if (!s.ok) return reject(s.reason, legacy)
      sha = sha || s.value
    }
  }
  if (sha) entry.sha256sum = sha

  for (const field of ['type', 'period']) {
    if (!isPresent(e[field])) continue
    const l = checkLabel(e[field], field)
    if (!l.ok) return reject(l.reason, e[field])
    entry[field] = l.value
  }

  if (isPresent(e.tx_index)) {
    const t = checkTxIndex(e.tx_index)
    if (!t.ok) return reject(t.reason, e.tx_index)
    entry.tx_index = t.value
  }

  return { ok: true, entry }
}

export function validateContributor(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'contributor is not an object', value: raw }
  }
  const c = raw
  const name = typeof c.name === 'string' ? c.name.trim() : null
  if (name === null || name.length < 1 || name.length > 64 || name.replace(CONTROL_CHARS, '') !== name) {
    return { ok: false, reason: 'contributor name is missing or has a disallowed form', value: c.name }
  }

  const contributor = { name }
  const dropped = []
  const take = (field, check) => {
    if (!isPresent(c[field])) return
    const r = check(c[field])
    if (r.ok) contributor[field] = r.value
    else dropped.push({ field, reason: r.reason, value: c[field] })
  }

  take('website', validateContributorLink)
  take('x', validateContributorLink)
  take('telegram', validateContributorLink)
  take('logoUrl', validateContributorLink)
  take('identity', v => (typeof v === 'string' && IDENTITY.test(v) ? { ok: true, value: v } : fail('identity is not 16 hex characters')))
  take('email', v => (typeof v === 'string' && v.length <= 254 && EMAIL.test(v) ? { ok: true, value: v } : fail('email has a disallowed form')))
  take('discord', v => (typeof v === 'string' && DISCORD.test(v) ? { ok: true, value: v } : fail('discord has a disallowed form')))
  take('description', v =>
    typeof v === 'string' && v.length <= 500 ? { ok: true, value: v.replace(CONTROL_CHARS, ' ') } : fail('description is not a string of at most 500 characters')
  )

  return { ok: true, contributor, dropped }
}

export function validateSnapshotEndpoint(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('snapshot endpoint is not an object')
  const e = raw
  if (!isPresent(e.snapshots)) return fail('feed url is missing')
  const feed = validateFeedUrl(e.snapshots)
  if (!feed.ok) return fail(`feed ${feed.reason}`)
  const endpoint = { snapshots: feed.value }
  for (const field of ['type', 'period']) {
    if (!isPresent(e[field])) continue
    const l = checkLabel(e[field], field)
    if (!l.ok) return l
    endpoint[field] = l.value
  }
  if (isPresent(e.tx_index)) {
    const t = checkTxIndex(e.tx_index)
    if (!t.ok) return t
    endpoint.tx_index = t.value
  }
  return { ok: true, value: endpoint }
}

export async function readFeedJson(response, maxBytes = MAX_FEED_BYTES) {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error(`Content-Length ${declared} exceeds ${maxBytes} bytes`)
  }
  if (!response.body) throw new Error('feed has no body')

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`body exceeds ${maxBytes} bytes`)
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return JSON.parse(text)
}

// ---------------------------------------------------------------------------------------------
// Registry-level rules that live outside feed.ts.
// ---------------------------------------------------------------------------------------------

// Height 0 means "from genesis" and is only meaningful for an archive snapshot. The sync stores a
// missing height as 0, so the rule applies to the height the marketplace lists, not only an explicit 0.
export function checkHeightZero(entry, effectiveType) {
  if (effectiveType === 'archive') return { ok: true }
  const type = effectiveType ? `"${effectiveType}"` : 'not set'
  if (entry.latest_block_height === undefined) {
    return fail(`has no latest_block_height, which the marketplace stores as height 0, but the snapshot type is ${type}; height 0 is allowed only for type "archive"`)
  }
  if (entry.latest_block_height === 0) {
    return fail(`latest_block_height is 0 but the snapshot type is ${type}; height 0 is allowed only for type "archive"`)
  }
  return { ok: true }
}

// Contributor names are compared without case and with collapsed whitespace.
function nameKey(name) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

function canonicalUrl(raw) {
  try {
    return typeof raw === 'string' ? new URL(raw).href : null
  } catch {
    return null
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Same order the sync uses: newest first by creation_date (or time).
function newestFirst(entries) {
  return [...entries].sort((a, b) => new Date(b.entry.creation_date || 0).getTime() - new Date(a.entry.creation_date || 0).getTime())
}

const KNOWN_TYPES = ['pruned', 'archive']
const TOP_KEYS = ['contributor', 'snapshots']
const CONTRIBUTOR_KEYS = ['name', 'email', 'discord', 'telegram', 'x', 'description', 'website', 'identity', 'logoUrl']
const ENDPOINT_KEYS = ['snapshots', 'type', 'period', 'tx_index']

// ---------------------------------------------------------------------------------------------
// Messages. Each problem names the field, the value found, what is expected and what the
// marketplace does with it.
// ---------------------------------------------------------------------------------------------

const URL_HINT = 'an https:// URL on a public DNS name, at most 2048 characters from A-Z a-z 0-9 . _ ~ : / ? & = % + , @ -, with no port, credentials, IP address or percent-encoding in the host'
const HINTS = {
  url: `${URL_HINT}, and no #fragment`,
  link: `${URL_HINT}; a #fragment is allowed`,
  filename: '1 to 200 characters from A-Z a-z 0-9 . _ -, starting with a letter or digit, without ".."',
  size: 'a number with a unit, for example "426Gb", "1.2T" or "3.4 GiB", or 1 to 15 digits; greater than 0, at most 24 characters',
  height: 'a whole number of at most 15 digits, as a JSON number or a string, for example "15093969"',
  date: 'an ISO 8601 date and time with Z or an offset, for example "2026-10-19T09:37:14Z", between 2019-01-01 and one day from now',
  sha: '64 hexadecimal characters',
  type: '1 to 32 characters from A-Z a-z 0-9 . _ -, for example "pruned" or "archive"',
  period: '1 to 32 characters from A-Z a-z 0-9 . _ -, for example "4h", "24h" or "1d"',
  tx_index: 'true or false, as a JSON boolean or the string "true" or "false"',
  checksum: 'an object such as { "sha256": "<64 hexadecimal characters>" }',
  name: 'a string of 1 to 64 characters after trimming, without control, bidirectional or zero-width characters',
  identity: 'the 16-character Keybase key suffix, hexadecimal, for example "C89053F92B77D8C0"',
  email: 'an email address such as "hello@example.com", at most 254 characters',
  discord: 'the Discord username of the contributor, 2 to 40 characters from A-Z a-z 0-9 . _ # -, for example "bombermine", not a server, an invite or a link',
  description: 'a string of at most 500 characters',
  registryFile: '1 to 100 characters from A-Z a-z 0-9 . _ - followed by .json, for example "mycontributor.json"'
}

function hintFor(field) {
  const f = field.replace(/^contributor\./, '')
  if (f === 'url' || f === 'download_url' || f === 'snapshots') return HINTS.url
  if (['website', 'x', 'telegram', 'logoUrl'].includes(f)) return HINTS.link
  if (['latest_block_height', 'block_height', 'height'].includes(f)) return HINTS.height
  if (f === 'creation_date' || f === 'time') return HINTS.date
  if (f === 'sha256sum' || f === 'checksum.sha256') return HINTS.sha
  return HINTS[f]
}

// Maps a reason from the ported rules to the field it is about.
function fieldOfReason(reason) {
  if (reason.startsWith('url ') || reason === 'no valid filename in url path') return null
  const m = /^(latest_block_height|block_height|height|creation_date|time|sha256sum|checksum\.sha256|checksum|type|period|tx_index|size|filename) /.exec(reason)
  return m ? m[1] : null
}

function show(value) {
  let s
  try {
    s = JSON.stringify(value)
  } catch {
    s = String(value)
  }
  if (s === undefined) s = String(value)
  return s.length > 120 ? `${s.slice(0, 120)}...` : s
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

class Report {
  constructor(file) {
    this.file = file
    this.lines = []
    this.errors = 0
    this.warnings = 0
  }

  add(level, where, message, expected, consequence) {
    if (level === 'error') this.errors++
    else this.warnings++
    this.lines.push({ level, where, message, expected, consequence })
  }

  error(where, message, expected, consequence) {
    this.add('error', where, message, expected, consequence)
  }

  warn(where, message, expected, consequence) {
    this.add('warning', where, message, expected, consequence)
  }

  info(text) {
    this.lines.push({ level: 'info', message: text })
  }
}

// ---------------------------------------------------------------------------------------------
// Feed fetch
// ---------------------------------------------------------------------------------------------

const PARSE_HINT = 'a trailing comma, a missing quote or a comment are common causes'

const NETWORK_ERRORS = [
  [['ENOTFOUND', 'EAI_AGAIN'], 'the host name does not resolve (DNS)'],
  [['ECONNREFUSED'], 'the host refused the connection'],
  [['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'], 'the connection timed out'],
  [['ECONNRESET', 'UND_ERR_SOCKET'], 'the connection was reset by the host'],
  [['CERT_HAS_EXPIRED'], 'the TLS certificate has expired'],
  [['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'], 'the TLS certificate is self-signed'],
  [['UNABLE_TO_VERIFY_LEAF_CERT', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCAL'], 'the TLS certificate chain is incomplete (the intermediate certificate is missing)'],
  [['ERR_TLS_CERT_ALTNAME_INVALID'], 'the TLS certificate does not match the host name']
]

function describeNetworkError(error, subject = 'the feed', verb = 'fetched') {
  if (error?.name === 'TimeoutError') return `${subject} did not answer within ${FEED_TIMEOUT_MS / 1000} seconds`
  const code = error?.cause?.code || error?.code
  const known = NETWORK_ERRORS.find(([codes]) => codes.includes(code))
  if (known) return `${subject} could not be ${verb}: ${known[1]} (${code})`
  return `${subject} could not be ${verb} (${code || error?.cause?.message || error?.message || error?.name})`
}

async function fetchFeed(url) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        headers: { 'User-Agent': 'snapsvault-registry-check' }
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        return { ok: false, reason: `the feed URL answers HTTP ${response.status} and redirects${location ? ` to ${location}` : ''}. Redirects are refused; list the final URL instead`, retry: false }
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        lastError = { ok: false, reason: `the feed URL answers HTTP ${response.status}; it must answer 200 with the JSON feed`, retry: response.status >= 500 || response.status === 429 }
        if (!lastError.retry) return lastError
        continue
      }
      try {
        return { ok: true, value: await readFeedJson(response, MAX_FEED_BYTES) }
      } catch (error) {
        if (error instanceof SyntaxError) return { ok: false, reason: `the feed is not valid JSON in UTF-8 (${error.message}); ${PARSE_HINT}`, retry: false }
        if (error instanceof TypeError && /encoded data|decode/i.test(error.message)) return { ok: false, reason: 'the feed is not valid UTF-8', retry: false }
        if (/exceeds/.test(error.message)) return { ok: false, reason: `${error.message}; a feed must be at most 1 MiB (1,048,576 bytes)`, retry: false }
        throw error
      }
    } catch (error) {
      const detail = describeNetworkError(error)
      lastError = { ok: false, reason: detail, retry: true, network: true }
    }
  }
  return lastError
}

// ---------------------------------------------------------------------------------------------
// Registry file checks
// ---------------------------------------------------------------------------------------------

function parseRegistryFile(root, file, report) {
  const abs = join(root, file)
  let text
  try {
    text = readFileSync(abs, 'utf8')
  } catch (error) {
    report.error('file', `cannot be read (${error.code || error.message})`)
    return null
  }
  if (text.charCodeAt(0) === 0xfeff) {
    report.error('file', 'starts with a UTF-8 byte order mark (BOM), which is not valid JSON', 'the file saved as UTF-8 without BOM', 'the sync cannot read the file')
    return null
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    report.error('file', `is not valid JSON (${error.message}); ${PARSE_HINT}`, 'a JSON object with "contributor" and "snapshots"', 'the sync cannot read the file')
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !('contributor' in data) || !('snapshots' in data)) {
    report.error('file', 'top level must be a JSON object with the keys "contributor" and "snapshots"', null, 'the sync skips the whole file')
    return null
  }
  return data
}

// The concrete correction for a rejected profile field.
function profileFix(field, value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const handle = text.replace(/^@/, '')
  if (field === 'telegram' || field === 'x') {
    const host = field === 'telegram' ? 't.me' : 'x.com'
    if (text.startsWith('@')) return `use the link form https://${host}/${handle} instead of ${text}`
    if (/^(www\.)?(t\.me|telegram\.me|x\.com|twitter\.com)\//i.test(text)) return `add https:// in front: https://${text}`
    if (text.startsWith('http://')) return `use https:// instead of http://`
    return `use the link form https://${host}/<handle>`
  }
  if (field === 'discord') return 'write the Discord username, for example bombermine, not a server, an invite or a link'
  if (field === 'website' || field === 'logoUrl') {
    if (text.startsWith('http://')) return 'use https:// instead of http://'
    if (!text.startsWith('https://')) return 'start the link with https://'
    return 'use a public DNS name without a port, credentials or special characters'
  }
  if (field === 'identity') return 'write only the 16 hexadecimal characters of the Keybase key, without 0x or spaces'
  if (field === 'email') return 'write the bare address, for example hello@example.com, without a name or mailto:'
  if (field === 'description') return 'shorten the text to 500 characters or fewer'
  return null
}

function checkRegistryData(data, report) {
  for (const key of Object.keys(data)) {
    if (!TOP_KEYS.includes(key)) report.warn(key, 'is not a registry field and is ignored', `one of ${TOP_KEYS.join(', ')}`)
  }

  const checked = validateContributor(data.contributor)
  if (!checked.ok) {
    const where = checked.reason === 'contributor is not an object' ? 'contributor' : 'contributor.name'
    const message = where === 'contributor.name' && (checked.value === undefined || checked.value === null)
      ? 'is missing'
      : `${show(checked.value)}: ${checked.reason}`
    report.error(where, message, where === 'contributor' ? 'an object with at least "name"' : HINTS.name, 'the sync skips the whole file')
    return null
  }
  if (typeof data.contributor.name === 'string' && data.contributor.name !== checked.contributor.name) {
    report.warn('contributor.name', `${show(data.contributor.name)} has leading or trailing spaces`, null, `the marketplace uses ${show(checked.contributor.name)}`)
  }
  for (const key of Object.keys(data.contributor)) {
    if (!CONTRIBUTOR_KEYS.includes(key)) {
      const suggestion = key === 'logo_url' ? ' (the field is spelled "logoUrl")' : ''
      report.warn(`contributor.${key}`, `is not a contributor field and is ignored${suggestion}`, `one of ${CONTRIBUTOR_KEYS.join(', ')}`)
    }
  }
  for (const d of checked.dropped) {
    const fix = profileFix(d.field, d.value)
    report.error(`contributor.${d.field}`, `${show(d.value)}: ${d.reason}`, `${hintFor(d.field)}${fix ? `; fix: ${fix}` : ''}`, 'the marketplace drops this field from the profile')
  }

  if (!Array.isArray(data.snapshots)) {
    report.error('snapshots', `is ${show(data.snapshots)}, not an array`, 'an array with one object per feed', 'the sync skips the whole file')
    return null
  }
  if (data.snapshots.length === 0) {
    report.error('snapshots', 'is empty', 'at least one feed, for example { "snapshots": "https://.../index.json", "type": "pruned" }', 'nothing is listed')
    return null
  }

  const endpoints = []
  data.snapshots.forEach((raw, i) => {
    const where = `snapshots[${i}]`
    const r = validateSnapshotEndpoint(raw)
    if (!r.ok) {
      const field = r.reason.startsWith('feed ') ? 'snapshots' : fieldOfReason(r.reason)
      const value = raw && typeof raw === 'object' && field ? raw[field] : raw
      const label = field ? `${where}.${field}` : where
      const message = r.reason === 'feed url is missing'
        ? 'has no feed URL in "snapshots"'
        : `${show(value)}: ${r.reason}`
      report.error(label, message, field ? hintFor(field) : 'an object with "snapshots" (the feed URL), "type", and optionally "period" and "tx_index"', 'the sync skips this feed')
      return
    }
    for (const key of Object.keys(raw)) {
      if (!ENDPOINT_KEYS.includes(key)) report.warn(`${where}.${key}`, 'is not a feed field and is ignored', `one of ${ENDPOINT_KEYS.join(', ')}`)
    }
    if (r.value.type && !KNOWN_TYPES.includes(r.value.type)) {
      report.warn(`${where}.type`, `${show(r.value.type)} is not one of the types the marketplace lists`, 'pruned or archive', 'the snapshots are listed under this type as written')
    }
    endpoints.push({ index: i, endpoint: r.value })
  })

  return { contributor: checked.contributor, endpoints }
}

const STATUS_WORDS = { 400: 'bad request', 401: 'sign-in required', 403: 'forbidden', 404: 'not found', 405: 'the server does not accept HEAD requests', 410: 'gone', 429: 'too many requests' }

// HEAD request on a download URL, redirects followed. Returns null when it answers 2xx, otherwise the problem in words.
async function checkDownload(url) {
  let problem
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        headers: { 'User-Agent': 'snapsvault-registry-check' }
      })
      await response.body?.cancel().catch(() => undefined)
      if (response.ok) return null
      const word = STATUS_WORDS[response.status] ?? (response.status >= 500 ? 'server error' : 'not a successful answer')
      problem = `answers HTTP ${response.status} (${word})`
      if (response.status < 500 && response.status !== 429) return problem
    } catch (error) {
      problem = describeNetworkError(error, '', 'reached').trim()
    }
  }
  return problem
}

const BARE_SIZE_LIMIT = 100000

// A JSON number is read as GB by the site and the CLI API; a digit string is shown as written and sorted as bytes.
function checkBareSize(size, where, report) {
  const isNumber = typeof size === 'number'
  const bare = isNumber || (typeof size === 'string' && SIZE_DIGITS.test(size))
  if (!bare) return
  const value = Number(size)
  const example = 'a number with a unit, for example "7Gb" or "7.5GB"'
  const effect = isNumber
    ? 'the marketplace and the CLI API read the number as GB'
    : 'the size is listed as written, without a unit, and sorted as bytes'
  if (value > BARE_SIZE_LIMIT) {
    report.error(`${where}`, `size ${show(size)} is a bare number above ${BARE_SIZE_LIMIT} and looks like bytes`, `${example}; convert bytes to GB`, effect)
  } else {
    report.warn(`${where}`, `size ${show(size)} has no unit`, example, effect)
  }
}

async function checkFeed(endpoint, where, report, now, fetchWarnings) {
  const feedUrl = endpoint.snapshots
  const fetched = await fetchFeed(feedUrl)
  if (!fetched.ok) {
    const level = fetched.network && fetchWarnings ? 'warn' : 'error'
    report[level](`${where}.snapshots`, `${feedUrl}: ${fetched.reason}`, null, 'this feed is shown as unavailable and nothing from it is listed')
    return null
  }
  const raw = fetched.value
  if (!Array.isArray(raw)) {
    report.error(`${where}.snapshots`, `${feedUrl}: the feed top level is ${raw === null ? 'null' : typeof raw}, not an array`, 'a JSON array with one object per snapshot', 'this feed is shown as unavailable')
    return null
  }
  report.info(`${where} feed ${feedUrl}: ${raw.length} ${raw.length === 1 ? 'entry' : 'entries'}`)

  const valid = []
  raw.forEach((item, index) => {
    const r = validateSnapshotEntry(item, now)
    const label = entryLabel(item, index, raw.length)
    if (!r.ok) {
      const field = fieldOfReason(r.reason) ?? (r.reason === 'entry is not an object' ? null : 'url')
      const message = r.reason === 'url is missing' ? 'has no "url"' : `${field ?? 'entry'} ${show(r.value)}: ${r.reason}`
      const expected = r.reason === 'no valid filename in url path'
        ? `the last part of the url path to be a file name (${HINTS.filename}), or a "filename" field`
        : r.reason === 'entry is not an object' ? 'a JSON object' : hintFor(field ?? 'url')
      report.error(`${where} ${label}`, message, expected, 'the marketplace skips this entry')
      return
    }
    valid.push({ index, label, entry: r.entry })
    checkBareSize(r.entry.size, `${where} ${label}`, report)
  })

  if (valid.length === 0) {
    if (raw.length === 0) {
      report.error(`${where}.snapshots`, `${feedUrl}: the feed is an empty array`, 'at least one entry object with a "url"', 'this feed is shown as unavailable')
    } else {
      report.error(`${where}.snapshots`, `${feedUrl}: no entry of this feed passed the checks above; every entry is skipped`, 'at least one entry that passes the checks above', 'this feed is shown as unavailable')
    }
    return null
  }

  const sorted = newestFirst(valid)
  const effectiveType = endpoint.type || sorted[0].entry.type || ''
  if (!endpoint.type) {
    if (effectiveType) {
      report.warn(`${where}.type`, `is not set; the type ${show(effectiveType)} is taken from the newest feed entry`, HINTS.type, 'set it in the registry file so the listing does not depend on the feed')
    } else {
      report.error(`${where}.type`, 'is not set in the registry file or in the newest feed entry', HINTS.type, 'the snapshots are listed with type "unknown"')
    }
  }

  const newest = sorted[0]
  const download = await checkDownload(newest.entry.url)
  if (download) {
    report.warn(`${where} ${newest.label}`, `download ${newest.entry.url} ${download}`, 'the newest archive answers a HEAD request with HTTP 200 over HTTPS', 'the marketplace lists the link as written; a broken link fails for every user who clicks it')
  }

  const seen = new Map()
  for (const v of valid) {
    const type = effectiveType || v.entry.type || ''
    const zero = checkHeightZero(v.entry, type)
    if (!zero.ok) {
      report.error(`${where} ${v.label}`, zero.reason, `the block height of the snapshot in latest_block_height (${HINTS.height}), or type "archive" for an archive that starts at genesis`, 'the snapshot is stored with height 0 (the REST API serves 0, the site shows "N/A"), and entries of this feed without a height collapse into one snapshot')
    } else if (v.entry.latest_block_height === undefined) {
      report.warn(`${where} ${v.label}`, 'has no latest_block_height', HINTS.height, 'the archive is stored with height 0 (from genesis; the site shows "N/A"), and entries of this feed without a height collapse into one snapshot')
    }
    if (v.entry.type && type && v.entry.type !== type) {
      const source = endpoint.type ? 'registry type' : 'type of the newest entry'
      report.warn(`${where} ${v.label}`, `type ${show(v.entry.type)} differs from the ${source} ${show(type)}`, `the same type in the entry and in the registry file, ${show(type)}`, `the ${source} ${show(type)} is used`)
    }
    if (v.entry.creation_date === undefined) {
      report.warn(`${where} ${v.label}`, 'has no creation_date', HINTS.date, 'the marketplace uses the time of the sync as the snapshot date')
    }
    if (v.entry.size === undefined) {
      report.warn(`${where} ${v.label}`, 'has no size', HINTS.size, 'the site shows "N/A" as the size of the snapshot')
    }
    if (v.entry.sha256sum === undefined) {
      report.warn(`${where} ${v.label}`, 'has no sha256sum', HINTS.sha, 'the site shows "N/A" as the checksum of the snapshot, and users cannot verify the download')
    }
    if (v.entry.latest_block_height !== undefined) {
      const key = String(v.entry.latest_block_height)
      if (seen.has(key)) {
        report.warn(`${where} ${v.label}`, `has the same latest_block_height ${key} as ${seen.get(key)}`, 'one entry per height and type', 'only one of these entries is kept')
      } else {
        seen.set(key, v.label)
      }
    }
  }

  if (valid.length > MAX_FEED_ENTRIES) {
    report.warn(`${where}.snapshots`, `${feedUrl}: ${valid.length} valid entries`, `at most ${MAX_FEED_ENTRIES}`, `only the newest ${MAX_FEED_ENTRIES} are kept`)
  }

  return { effectiveType }
}

function entryLabel(item, index, total) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const name = typeof item.filename === 'string' && item.filename ? item.filename
      : typeof (item.url ?? item.download_url) === 'string' ? String(item.url ?? item.download_url).split(/[?#]/)[0].split('/').pop() : ''
    if (name) return `entry ${index + 1} of ${total} (${name.length > 60 ? `${name.slice(0, 60)}...` : name})`
  }
  return `entry ${index + 1} of ${total}`
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function listDirs(abs) {
  if (!existsSync(abs)) return []
  return readdirSync(abs, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
}

// Every file under chains/, relative to root with forward slashes: tracked and new files that
// .gitignore does not exclude, or every file on disk outside a git checkout.
function walkChains(root) {
  try {
    return git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'chains']).split('\0').filter(Boolean).filter(f => existsSync(join(root, f))).sort()
  } catch {
    // not a git checkout
  }
  const out = []
  const walk = dir => {
    for (const d of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${d.name}`
      if (d.isDirectory()) walk(rel)
      else out.push(rel)
    }
  }
  if (existsSync(join(root, 'chains'))) walk('chains')
  return out.sort()
}

// Known networks and chain IDs: the folders of the base branch on a pull request, otherwise the working tree.
function knownChains(root, baseRef) {
  const known = new Map()
  if (baseRef) {
    const networks = git(root, ['ls-tree', '-d', '--name-only', `${baseRef}:chains`]).split('\n').filter(Boolean)
    for (const n of networks) {
      known.set(n, new Set(git(root, ['ls-tree', '-d', '--name-only', `${baseRef}:chains/${n}`]).split('\n').filter(Boolean)))
    }
    return known
  }
  for (const n of listDirs(join(root, 'chains'))) known.set(n, new Set(listDirs(join(root, 'chains', n))))
  return known
}

// Returns null for a contributor file, or the problem with the path. README.md files are allowed at the
// chains/ and network levels.
export function checkPath(file, known) {
  const parts = file.split('/')
  if (parts[0] !== 'chains') {
    if (/\.json$/i.test(file)) {
      return { problem: 'is a JSON file outside chains/; contributor files belong at chains/<network>/<chain ID>/<contributor>.json', expected: `a path such as chains/${[...known.keys()][0] ?? 'celestia'}/<chain ID>/<contributor>.json` }
    }
    return { skip: true }
  }
  if (parts.length === 2 && parts[1] === 'README.md') return { skip: true }
  if (parts.length === 3 && parts[2] === 'README.md' && known.has(parts[1])) return { skip: true }
  const networks = [...known.keys()]
  if (parts.length !== 4) {
    return { problem: 'is not at chains/<network>/<chain ID>/<contributor>.json', expected: `a path such as chains/${networks[0] ?? 'celestia'}/<chain ID>/<contributor>.json` }
  }
  const [, network, chainId, name] = parts
  if (!known.has(network)) {
    return { problem: `uses the network folder "${network}", which is not in the registry`, expected: `one of: ${networks.join(', ')}` }
  }
  const ids = [...known.get(network)]
  if (!known.get(network).has(chainId)) {
    return { problem: `uses the chain ID folder "${chainId}", which is not in the registry. New chain IDs are added by the SnapsVault team; open an issue to request one`, expected: `one of: ${ids.join(', ')}` }
  }
  if (!validateDirectoryName(network).ok || !validateDirectoryName(chainId).ok) {
    return { problem: 'has a folder name the sync skips', expected: '1 to 64 characters from A-Z a-z 0-9 . _ -' }
  }
  if (!name.endsWith('.json')) {
    return { problem: 'is not a .json file; only contributor files belong in a chain ID folder', expected: HINTS.registryFile }
  }
  if (!validateRegistryFileName(name).ok) {
    return { problem: `has the file name "${name}", which the sync skips`, expected: HINTS.registryFile }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { base: null, files: [], fetchWarnings: false, root: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') {
      opts.base = argv[++i]
      if (!opts.base) throw new Error('--base needs a git ref, for example --base origin/main')
    } else if (a === '--root') {
      opts.root = argv[++i]
      if (!opts.root) throw new Error('--root needs a folder')
    } else if (a === '--fetch-warnings') {
      opts.fetchWarnings = true
    } else if (a === '--help' || a === '-h') {
      opts.help = true
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option ${a}`)
    } else {
      opts.files.push(a)
    }
  }
  if (opts.base && opts.files.length > 0) throw new Error('pass either --base or file paths, not both')
  return opts
}

function selectFiles(root, opts) {
  if (opts.base) {
    git(root, ['rev-parse', '--verify', '--quiet', `${opts.base}^{commit}`])
    const out = git(root, ['diff', '--name-status', '--no-renames', '-z', `${opts.base}...HEAD`])
    const fields = out.split('\0').filter(Boolean)
    const changed = []
    const deleted = []
    for (let i = 0; i < fields.length; i += 2) {
      const status = fields[i]
      const path = fields[i + 1]
      if (status === 'D') deleted.push(path)
      else changed.push(path)
    }
    return { mode: `changed since ${opts.base}`, files: changed.sort(), deleted: deleted.sort() }
  }
  if (opts.files.length > 0) {
    // Relative to the repository root, or to the current directory when only that one exists.
    const locate = f => (!existsSync(resolve(root, f)) && existsSync(resolve(f)) ? resolve(f) : resolve(root, f))
    const files = opts.files.map(f => relative(root, locate(f)).split(sep).join('/'))
    return { mode: 'given files', files, deleted: [], explicit: true }
  }
  return { mode: 'all files', files: walkChains(root), deleted: [] }
}

// Text from feeds, git and error messages can hold line breaks. A line that starts with "::" is a
// GitHub Actions workflow command, so every printed value is kept on one line.
function oneLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ')
}

function annotate(file, level, text) {
  if (!process.env.GITHUB_ACTIONS) return
  const esc = s => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  const props = file ? ` file=${file.replace(/[,:%]/g, c => encodeURIComponent(c))}` : ''
  console.log(`::${level}${props}::${esc(text)}`)
}

function printReport(report) {
  const status = report.errors > 0 ? 'FAIL' : 'ok'
  const counts = [report.errors && `${report.errors} error${report.errors === 1 ? '' : 's'}`, report.warnings && `${report.warnings} warning${report.warnings === 1 ? '' : 's'}`].filter(Boolean).join(', ')
  const file = oneLine(report.file)
  console.log(`\n${status}  ${file}${counts ? `  (${counts})` : ''}`)
  for (const l of report.lines) {
    if (l.level === 'info') {
      console.log(`      ${oneLine(l.message)}`)
      continue
    }
    const head = oneLine(`${l.where} ${l.message}`)
    const expected = l.expected && oneLine(l.expected)
    const consequence = l.consequence && oneLine(l.consequence)
    console.log(`  ${l.level === 'error' ? 'error  ' : 'warning'} ${head}`)
    if (expected) console.log(`          expected: ${expected}`)
    if (consequence) console.log(`          effect:   ${consequence}`)
    const text = [head, expected && `Expected: ${expected}.`, consequence && `Effect: ${consequence}.`].filter(Boolean).join('\n')
    annotate(file, l.level, text)
  }
}

export async function run(argv, rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'), now = Date.now()) {
  let root = rootDir
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    console.error(`error: ${error.message}`)
    return 2
  }
  if (opts.root) {
    root = resolve(opts.root)
    if (!existsSync(root)) {
      console.error(`error: --root ${oneLine(opts.root)} does not exist`)
      return 2
    }
  }
  if (opts.help) {
    console.log('usage: node scripts/validate.mjs [--root <dir>] [--fetch-warnings] [--base <git ref> | <file>...]')
    return 0
  }

  let selection
  let known
  try {
    selection = selectFiles(root, opts)
    known = knownChains(root, opts.base)
  } catch (error) {
    console.error(`error: ${oneLine((error.stderr || error.message || '').toString().trim())}`)
    return 2
  }

  console.log(`SnapsVault registry check: ${selection.mode}`)
  for (const d of selection.deleted) console.log(`removed  ${oneLine(d)}`)

  // Every contributor file in the tree, used for the cross-file checks below.
  const all = new Map()
  const tree = knownChains(root, null)
  for (const f of walkChains(root)) {
    if (checkPath(f, tree) !== null) continue
    try {
      const data = JSON.parse(readFileSync(join(root, f), 'utf8'))
      const name = typeof data?.contributor?.name === 'string' ? data.contributor.name.trim() : null
      if (name) {
        const feeds = new Set((Array.isArray(data.snapshots) ? data.snapshots : []).map(e => canonicalUrl(e?.snapshots)).filter(Boolean))
        all.set(f, { name, key: nameKey(name), contributor: data.contributor, feeds })
      }
    } catch {
      // reported when the file itself is checked
    }
  }

  const reports = []
  let checked = 0
  for (const file of selection.files) {
    const pathCheck = checkPath(file, known)
    const outside = file.split('/')[0] !== 'chains'
    if (pathCheck?.skip && !(selection.explicit && outside)) continue
    checked++
    const report = new Report(file)
    reports.push(report)

    if (selection.explicit && outside) {
      report.error('path', 'is not a file under chains/ in this repository', 'a path relative to the repository root, such as chains/celestia/<chain ID>/<contributor>.json', 'nothing was checked')
      continue
    }
    if (pathCheck) {
      report.error('path', pathCheck.problem, pathCheck.expected, 'the sync does not read this file')
      continue
    }
    const abs = join(root, file)
    let stat
    try {
      stat = lstatSync(abs)
    } catch {
      report.error('path', 'does not exist')
      continue
    }
    if (!stat.isFile()) {
      report.error('path', 'is not a regular file (symbolic links are not read by the sync)', 'a regular JSON file')
      continue
    }

    const data = parseRegistryFile(root, file, report)
    if (!data) continue
    const parsed = checkRegistryData(data, report)
    if (!parsed) continue

    const name = parsed.contributor.name
    const base = file.split('/')[3]
    const key = nameKey(name)
    const urls = parsed.endpoints.map(e => ({ index: e.index, url: canonicalUrl(e.endpoint.snapshots) }))
    for (const [other, info] of all) {
      if (other === file) continue
      if (info.key === key) {
        const sameCase = info.name === name ? '' : ` (the names match without case and extra spaces: ${show(info.name)})`
        if (other.split('/')[3] !== base) {
          report.error('contributor.name', `${show(name)} is also used by ${other}${sameCase}`, 'a name no other contributor uses, or the same file name as the existing files of that contributor', 'the file would write to the profile of another contributor')
          continue
        }
        if (canonicalJson(info.contributor) !== canonicalJson(data.contributor)) {
          report.error('contributor', `differs from the profile in ${other}`, 'the same contributor object in every file of one contributor', 'the profile shown alternates between the two versions')
        }
        continue
      }
      for (const { index, url } of urls) {
        if (info.feeds.has(url)) {
          report.error(`snapshots[${index}].snapshots`, `${show(url)} is also listed by ${other}`, 'a feed URL that only this contributor lists', 'two contributors would list the same snapshots')
        }
      }
    }

    const types = new Map()
    for (const { index, endpoint } of parsed.endpoints) {
      const where = `snapshots[${index}]`
      const feed = await checkFeed(endpoint, where, report, now, opts.fetchWarnings)
      const type = feed?.effectiveType ?? endpoint.type
      if (type) {
        if (types.has(type)) {
          report.error(`${where}.type`, `${show(type)} is also the type of ${types.get(type)}`, 'one feed per snapshot type in a file', 'both feeds write to the same listing')
        } else {
          types.set(type, where)
        }
      }
    }
  }

  for (const r of reports) printReport(r)

  const errors = reports.reduce((n, r) => n + r.errors, 0)
  const warnings = reports.reduce((n, r) => n + r.warnings, 0)
  const failed = reports.filter(r => r.errors > 0).length
  console.log(`\n${checked} contributor ${checked === 1 ? 'file' : 'files'} checked, ${failed} failed, ${errors} ${errors === 1 ? 'error' : 'errors'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`)
  if (checked === 0) console.log('No contributor files to check.')
  return errors > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2))
}
