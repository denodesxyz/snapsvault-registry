// Run with: node --test test/validate.test.mjs
// Feeds are served by a stubbed fetch, so the test needs no network.
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkHeightZero, checkPath, run } from '../scripts/validate.mjs'
import { NOW } from './vectors.mjs'

const FEED = 'https://feed.example.com/index.json'
const SHA = 'db174c6a5d7b419e7d623df5e291ba428c0f6775fd0e4cbb766f76589e5bcdbb'
const GOOD_ENTRY = { url: 'https://feed.example.com/celestia_15093969.tar.lz4', type: 'pruned', period: '4h', size: '15Gb', creation_date: '2026-10-19T09:37:14Z', latest_block_height: '15093969', sha256sum: SHA }
const contributor = (name, snapshots = [{ snapshots: FEED, type: 'pruned', period: '4h', tx_index: false }]) => ({
  contributor: { name, website: 'https://contributor.example.com' },
  snapshots
})

// url -> Response factory
let feeds = {}
// url -> Response factory for HEAD requests; a download answers 200 unless listed here
let heads = {}
let headCalls = []
globalThis.fetch = async (url, init) => {
  if (init?.method === 'HEAD') {
    headCalls.push({ url, init })
    return (heads[url] ?? (() => new Response(null, { status: 200 })))()
  }
  const make = feeds[url]
  if (!make) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
  return make()
}
const json = body => () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  heads = {}
  headCalls = []
})

const dirs = []
after(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })))

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'registry-test-'))
  dirs.push(root)
  write(root, { 'chains/README.md': '# chains\n', ...files })
  const g = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  g(['init', '-q', '-b', 'main'])
  g(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'])
  g(['add', '-A'])
  g(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base files'])
  return { root, g }
}

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
}

async function check(root, argv = []) {
  const lines = []
  const log = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try {
    const code = await run(argv, root, NOW)
    return { code, out: lines.join('\n') }
  } finally {
    console.log = log
  }
}

test('checkPath accepts contributor files and READMEs, rejects everything else', () => {
  const known = new Map([['celestia', new Set(['celestia', 'mocha-5'])]])
  assert.equal(checkPath('chains/celestia/celestia/deNodes.json', known), null)
  assert.deepEqual(checkPath('README.md', known), { skip: true })
  assert.deepEqual(checkPath('chains/README.md', known), { skip: true })
  assert.deepEqual(checkPath('chains/celestia/README.md', known), { skip: true })
  assert.match(checkPath('chains/celestia/mocha-6/x.json', known).problem, /chain ID folder "mocha-6"/)
  assert.match(checkPath('chains/osmosis/osmosis-1/x.json', known).problem, /network folder "osmosis"/)
  assert.match(checkPath('chains/celestia/celestia/x.yaml', known).problem, /not a \.json file/)
  assert.match(checkPath('chains/celestia/celestia/bad name.json', known).problem, /file name/)
  assert.match(checkPath('chains/celestia/celestia/..json', known).problem, /file name/)
  assert.match(checkPath('chains/celestia/x.json', known).problem, /not at chains/)
  assert.match(checkPath('chains/celestia/celestia/sub/x.json', known).problem, /not at chains/)
})

test('height 0 is allowed only for archive', () => {
  assert.equal(checkHeightZero({ latest_block_height: 0 }, 'archive').ok, true)
  assert.equal(checkHeightZero({ latest_block_height: 0 }, 'pruned').ok, false)
  assert.equal(checkHeightZero({ latest_block_height: 0 }, '').ok, false)
  assert.equal(checkHeightZero({ latest_block_height: 5 }, 'pruned').ok, true)
  assert.equal(checkHeightZero({}, 'pruned').ok, false)
  assert.equal(checkHeightZero({}, '').ok, false)
  assert.equal(checkHeightZero({}, 'archive').ok, true)
})

test('a correct file passes', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY]) }
  const { root } = repo({ 'chains/celestia/celestia/good.json': contributor('Good') })
  const { code, out } = await check(root)
  assert.equal(code, 0, out)
  assert.match(out, /1 contributor file checked, 0 failed, 0 errors, 0 warnings/)
})

const BROKEN = [
  ['invalid JSON', '{ "contributor": ', /is not valid JSON/],
  ['array at top level', [], /top level must be a JSON object/],
  ['missing name', { contributor: {}, snapshots: [{ snapshots: FEED }] }, /error {2} contributor\.name is missing(?![\s\S]*undefined)[\s\S]*expected: a string of 1 to 64 characters/],
  ['bad email', { ...contributor('P'), contributor: { name: 'P', email: 'nope' } }, /contributor\.email "nope": email has a disallowed form[\s\S]*drops this field/],
  ['snapshots not an array', { contributor: { name: 'P' }, snapshots: FEED }, /snapshots is "https:\/\/feed\.example\.com\/index\.json", not an array/],
  ['empty snapshots', contributor('P', []), /snapshots is empty/],
  ['http feed', contributor('P', [{ snapshots: 'http://feed.example.com/index.json', type: 'pruned' }]), /snapshots\[0\]\.snapshots "http:\/\/feed\.example\.com\/index\.json": feed url does not start with https:\/\//],
  ['bad type label', contributor('P', [{ snapshots: FEED, type: 'Pruned!' }]), /snapshots\[0\]\.type "Pruned!": type has a disallowed form/],
  ['bad tx_index', contributor('P', [{ snapshots: FEED, type: 'pruned', tx_index: 'yes' }]), /snapshots\[0\]\.tx_index "yes": tx_index is not a boolean/],
  ['two feeds with one type', contributor('P', [{ snapshots: FEED, type: 'pruned' }, { snapshots: 'https://feed.example.com/other.json', type: 'pruned' }]), /snapshots\[1\]\.type "pruned" is also the type of snapshots\[0\]/]
]

for (const [label, content, expected] of BROKEN) {
  test(`registry file error: ${label}`, async () => {
    feeds = { [FEED]: json([GOOD_ENTRY]), 'https://feed.example.com/other.json': json([GOOD_ENTRY]) }
    const { root } = repo({ 'chains/celestia/celestia/p.json': content })
    const { code, out } = await check(root)
    assert.equal(code, 1, out)
    assert.match(out, expected)
  })
}

const BROKEN_FEEDS = [
  ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/index.json' } }), /answers HTTP 302 and redirects to https:\/\/cdn\.example\.com\/index\.json/],
  ['404', () => new Response('nope', { status: 404 }), /answers HTTP 404/],
  ['not JSON', () => new Response('<html>'), /not valid JSON/],
  ['object at top level', json({ snapshots: [] }), /top level is object, not an array/],
  ['empty array', json([]), /the feed is an empty array[\s\S]*expected: at least one entry/],
  ['too large', () => new Response('[]', { headers: { 'content-length': '2000000' } }), /Content-Length 2000000 exceeds 1048576 bytes; a feed must be at most 1 MiB/],
  ['bad size', json([{ ...GOOD_ENTRY, size: '15 Gigs' }]), /entry 1 of 1 \(celestia_15093969\.tar\.lz4\) size "15 Gigs": size has a disallowed form[\s\S]*expected: a number with a unit/],
  ['bad height', json([{ ...GOOD_ENTRY, latest_block_height: '15,093,969' }]), /latest_block_height "15,093,969": latest_block_height has a disallowed form/],
  ['date without timezone', json([{ ...GOOD_ENTRY, creation_date: '2026-10-19T09:37:14' }]), /creation_date "2026-10-19T09:37:14": creation_date is not an ISO 8601 date with a timezone/],
  ['impossible date', json([{ ...GOOD_ENTRY, creation_date: '2026-02-30T00:00:00Z' }]), /not a real calendar date/],
  ['short sha256', json([{ ...GOOD_ENTRY, sha256sum: SHA.slice(2) }]), /sha256sum ".*": sha256sum is not 64 hex characters/],
  ['http download', json([{ ...GOOD_ENTRY, url: 'http://feed.example.com/a.tar' }]), /entry 1 of 1 \(a\.tar\) url "http:\/\/feed\.example\.com\/a\.tar": url does not start with https:\/\//],
  ['ip download', json([{ url: 'https://10.0.0.1/a.tar', type: 'pruned' }]), /url host is not a DNS name \(IP literal or numeric TLD\)/],
  ['no filename', json([{ url: 'https://feed.example.com/', type: 'pruned' }]), /no valid filename in url path/],
  ['tx_index string', json([{ ...GOOD_ENTRY, tx_index: 'no' }]), /tx_index "no": tx_index is not a boolean/],
  ['height 0 pruned', json([{ ...GOOD_ENTRY, latest_block_height: 0 }]), /latest_block_height is 0 but the snapshot type is "pruned"; height 0 is allowed only for type "archive"/],
  ['no height pruned', json([{ ...GOOD_ENTRY, latest_block_height: undefined }]), /has no latest_block_height, which the marketplace stores as height 0, but the snapshot type is "pruned"; height 0 is allowed only for type "archive"/],
  ['feed body with workflow commands', () => new Response('x\n::error::spoofed\r\n::add-mask::secret'), /not valid JSON/],
  ['missing url', json([{ ...GOOD_ENTRY, url: '' }]), /entry 1 of 1 has no "url"[\s\S]*no entry of this feed passed the checks above/],
  ['bad size is the only entry', json([{ ...GOOD_ENTRY, size: '15 Gigs' }]), /no entry of this feed passed the checks above; every entry is skipped(?![\s\S]*valid "url")/],
  ['timeout', () => { throw new DOMException('timed out', 'TimeoutError') }, /did not answer within 10 seconds/]
]

for (const [label, response, expected] of BROKEN_FEEDS) {
  test(`feed error: ${label}`, async () => {
    feeds = { [FEED]: response }
    const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
    const { code, out } = await check(root)
    assert.equal(code, 1, out)
    assert.match(out, expected)
    assert.doesNotMatch(out, /^\s*::(?!(error|warning) file=)/m, 'only the validator annotations may start a workflow command')
  })
}

test('entries are numbered from 1 with the entry count', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY, { ...GOOD_ENTRY, url: 'https://feed.example.com/second.tar.lz4', size: '15 Gigs' }]) }
  const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
  const { code, out } = await check(root)
  assert.equal(code, 1, out)
  assert.match(out, /entry 2 of 2 \(second\.tar\.lz4\) size "15 Gigs"/)
  assert.doesNotMatch(out, /entry #/)
})

test('a bare size above 100000 is an error, a smaller bare size is a warning', async () => {
  const sized = async size => {
    feeds = { [FEED]: json([{ ...GOOD_ENTRY, size }]) }
    const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
    return check(root)
  }
  for (const size of [7516192768, '7516192768', 100001]) {
    const { code, out } = await sized(size)
    assert.equal(code, 1, out)
    assert.match(out, /error {3}snapshots\[0\] entry 1 of 1 \(celestia_15093969\.tar\.lz4\) size "?\d+"? is a bare number above 100000 and looks like bytes[\s\S]*unit, for example "7Gb"/s)
  }
  for (const size of [15, '15', 100000]) {
    const { code, out } = await sized(size)
    assert.equal(code, 0, out)
    assert.match(out, /warning snapshots\[0\] entry 1 of 1 .*size .*has no unit\n/)
    assert.match(out, typeof size === 'number' ? /the marketplace and the CLI API read the number as GB/ : /listed as written, without a unit, and sorted as bytes/)
  }
  const { code, out } = await sized('15Gb')
  assert.equal(code, 0, out)
  assert.doesNotMatch(out, /size/)
})

test('an entry type that differs from the registry type is a warning', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY, { ...GOOD_ENTRY, url: 'https://feed.example.com/b.tar.lz4', type: 'archive', latest_block_height: '15093000', creation_date: '2026-10-18T09:37:14Z' }]) }
  const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
  const { code, out } = await check(root)
  assert.equal(code, 0, out)
  assert.match(out, /warning snapshots\[0\] entry 2 of 2 \(b\.tar\.lz4\) type "archive" differs from the registry type "pruned"/)
  assert.match(out, /effect: {3}the registry type "pruned" is used/)
  assert.doesNotMatch(out, /entry 1 of 2.*differs/)
})

const NETWORK = [
  ['ENOTFOUND', /the host name does not resolve \(DNS\)/],
  ['EAI_AGAIN', /the host name does not resolve \(DNS\)/],
  ['ECONNREFUSED', /the host refused the connection/],
  ['ETIMEDOUT', /the connection timed out/],
  ['UND_ERR_CONNECT_TIMEOUT', /the connection timed out/],
  ['ECONNRESET', /the connection was reset by the host/],
  ['CERT_HAS_EXPIRED', /the TLS certificate has expired/],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', /the TLS certificate is self-signed/],
  ['UNABLE_TO_VERIFY_LEAF_CERT', /the TLS certificate chain is incomplete/],
  ['ERR_TLS_CERT_ALTNAME_INVALID', /the TLS certificate does not match the host name/]
]

for (const [code, expected] of NETWORK) {
  test(`network error ${code} is described in plain words`, async () => {
    feeds = { [FEED]: () => { throw new TypeError('fetch failed', { cause: { code } }) } }
    const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
    const { code: exit, out } = await check(root)
    assert.equal(exit, 1, out)
    assert.match(out, expected)
    assert.match(out, new RegExp(`\\(${code}\\)`))
  })
}

test('a byte order mark in the registry file is named', async () => {
  const { root } = repo({ 'chains/celestia/celestia/p.json': `\uFEFF${JSON.stringify(contributor('P'))}` })
  const { code, out } = await check(root)
  assert.equal(code, 1, out)
  assert.match(out, /file starts with a UTF-8 byte order mark \(BOM\)/)
  assert.match(out, /expected: the file saved as UTF-8 without BOM/)
  assert.doesNotMatch(out, /Unexpected token/)
})

test('JSON parse errors carry a hint about common causes', async () => {
  feeds = { [FEED]: () => new Response('[{"url": "https://feed.example.com/a.tar",}]') }
  const { root } = repo({
    'chains/celestia/celestia/p.json': contributor('P'),
    'chains/celestia/mocha-5/q.json': '{ "contributor": { "name": "Q", }, "snapshots": [] }'
  })
  const { code, out } = await check(root)
  assert.equal(code, 1, out)
  const hint = /a trailing comma, a missing quote or a comment are common causes/g
  const report = out.split('\n').filter(line => !line.trimStart().startsWith('::')).join('\n')
  assert.equal(report.match(hint).length, 2, out)
})

const PROFILE_FIXES = [
  ['telegram', '@mycontributor', /fix: use the link form https:\/\/t\.me\/mycontributor instead of @mycontributor/],
  ['telegram', 't.me/mycontributor', /fix: add https:\/\/ in front: https:\/\/t\.me\/mycontributor/],
  ['x', '@mycontributor', /fix: use the link form https:\/\/x\.com\/mycontributor instead of @mycontributor/],
  ['discord', 'https://discord.gg/abc', /fix: write the Discord username, for example bombermine, not a server, an invite or a link/],
  ['website', 'http://mycontributor.example', /fix: use https:\/\/ instead of http:\/\//],
  ['logoUrl', 'mycontributor.example/logo.png', /fix: start the link with https:\/\//],
  ['identity', '0xC89053F92B77D8C0', /fix: write only the 16 hexadecimal characters of the Keybase key, without 0x or spaces/],
  ['email', 'Ops <ops@mycontributor.example>', /fix: write the bare address, for example hello@example\.com, without a name or mailto:/],
  ['description', 'x'.repeat(501), /fix: shorten the text to 500 characters or fewer/]
]

for (const [field, value, expected] of PROFILE_FIXES) {
  test(`invalid profile field ${field} (${value.slice(0, 20)}) names the fix`, async () => {
    const { root } = repo({ 'chains/celestia/celestia/p.json': { ...contributor('P'), contributor: { name: 'P', [field]: value } } })
    feeds = { [FEED]: json([GOOD_ENTRY]) }
    const { code, out } = await check(root)
    assert.equal(code, 1, out)
    assert.match(out, expected)
  })
}

const GOOD_URL = GOOD_ENTRY.url

test('the newest entry download is checked with a HEAD request that follows redirects', async () => {
  const older = { ...GOOD_ENTRY, url: 'https://feed.example.com/older.tar.lz4', latest_block_height: '15000000', creation_date: '2026-10-18T09:37:14Z' }
  feeds = { [FEED]: json([older, GOOD_ENTRY]) }
  const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
  const { code, out } = await check(root)
  assert.equal(code, 0, out)
  assert.match(out, /0 warnings/)
  assert.deepEqual(headCalls.map(c => c.url), [GOOD_URL])
  assert.equal(headCalls[0].init.redirect, 'follow')
  assert.ok(headCalls[0].init.signal)
})

const UNREACHABLE = [
  ['404', () => new Response(null, { status: 404 }), /download https:\/\/feed\.example\.com\/celestia_15093969\.tar\.lz4 answers HTTP 404 \(not found\)/],
  ['403', () => new Response(null, { status: 403 }), /answers HTTP 403 \(forbidden\)/],
  ['500', () => new Response(null, { status: 500 }), /answers HTTP 500 \(server error\)/],
  ['dns', () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) }, /could not be reached: the host name does not resolve \(DNS\)/],
  ['timeout', () => { throw new DOMException('timed out', 'TimeoutError') }, /did not answer within 10 seconds/]
]

for (const [label, response, expected] of UNREACHABLE) {
  test(`an unreachable download is a warning: ${label}`, async () => {
    feeds = { [FEED]: json([GOOD_ENTRY]) }
    heads = { [GOOD_URL]: response }
    const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
    const { code, out } = await check(root)
    assert.equal(code, 0, out)
    assert.match(out, /warning snapshots\[0\] entry 1 of 1 \(celestia_15093969\.tar\.lz4\)/)
    assert.match(out, expected)
    assert.match(out, /1 warning/)
  })
}

test('a download that fails once and answers on the retry passes', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY]) }
  let calls = 0
  heads = { [GOOD_URL]: () => (++calls === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 200 })) }
  const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
  const { out } = await check(root)
  assert.equal(calls, 2)
  assert.match(out, /0 warnings/)
})

test('--fetch-warnings turns feed network errors and timeouts into warnings', async () => {
  const outage = [
    () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) },
    () => { throw new DOMException('timed out', 'TimeoutError') }
  ]
  for (const make of outage) {
    feeds = { [FEED]: make }
    const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
    const strict = await check(root)
    assert.equal(strict.code, 1, strict.out)
    const lenient = await check(root, ['--fetch-warnings'])
    assert.equal(lenient.code, 0, lenient.out)
    assert.match(lenient.out, /warning snapshots\[0\]\.snapshots https:\/\/feed\.example\.com\/index\.json: the feed/)
    assert.match(lenient.out, /1 warning/)
  }
})

test('--fetch-warnings keeps other feed problems as errors', async () => {
  feeds = { [FEED]: () => new Response('nope', { status: 404 }) }
  const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
  const { code, out } = await check(root, ['--fetch-warnings'])
  assert.equal(code, 1, out)
  assert.match(out, /answers HTTP 404/)
})

test('height 0 passes for an archive feed', async () => {
  feeds = { [FEED]: json([{ ...GOOD_ENTRY, type: 'archive', latest_block_height: 0 }]) }
  const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P', [{ snapshots: FEED, type: 'archive' }]) })
  const { code, out } = await check(root)
  assert.equal(code, 0, out)
})

test('an archive without a height is a warning', async () => {
  feeds = { [FEED]: json([{ ...GOOD_ENTRY, type: 'archive', latest_block_height: undefined }]) }
  const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P', [{ snapshots: FEED, type: 'archive' }]) })
  const { code, out } = await check(root)
  assert.equal(code, 0, out)
  assert.match(out, /warning snapshots\[0\] entry 1 of 1 \(celestia_15093969\.tar\.lz4\) has no latest_block_height/)
})

test('an entry without size or sha256sum gets a warning for each', async () => {
  feeds = { [FEED]: json([{ ...GOOD_ENTRY, size: undefined, sha256sum: undefined }]) }
  const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
  const { code, out } = await check(root)
  assert.equal(code, 0, out)
  assert.match(out, /warning snapshots\[0\] entry 1 of 1 \(celestia_15093969\.tar\.lz4\) has no size/)
  assert.match(out, /warning snapshots\[0\] entry 1 of 1 \(celestia_15093969\.tar\.lz4\) has no sha256sum/)
  assert.match(out, /the site shows "N\/A"/)
})

test('an entry with all six fields gets no warning', async () => {
  feeds = { [FEED]: json([{ ...GOOD_ENTRY, filename: 'celestia_15093969.tar.lz4' }]) }
  const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
  const { code, out } = await check(root)
  assert.equal(code, 0, out)
  assert.doesNotMatch(out, /warning snapshots/)
  assert.match(out, /0 warnings/)
})

test('warnings do not fail the check', async () => {
  feeds = { [FEED]: json([{ url: 'https://feed.example.com/latest.tar.lz4', type: 'snapshot', latest_block_height: '15093969' }]) }
  const { root } = repo({ 'chains/celestia/celestia/p.json': { ...contributor('P', [{ snapshots: FEED }]), contributor: { name: 'P', logo_url: 'https://cdn.example.com/a.png' } } })
  const { code, out } = await check(root)
  assert.equal(code, 0, out)
  assert.match(out, /contributor\.logo_url is not a contributor field and is ignored \(the field is spelled "logoUrl"\)/)
  assert.match(out, /type is not set; the type "snapshot" is taken from the newest feed entry/)
  assert.match(out, /has no creation_date/)
})

test('one contributor name per chain ID', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY]) }
  const { root } = repo({ 'chains/celestia/celestia/a.json': contributor('Same'), 'chains/celestia/celestia/b.json': contributor('Same') })
  const { code, out } = await check(root)
  assert.equal(code, 1, out)
  assert.match(out, /contributor\.name "Same" is also used by chains\/celestia\/celestia\/b\.json/)
})

const DENODES = { 'chains/celestia/celestia/deNodes.json': contributor('deNodes') }

test('a name that matches another contributor without case or extra spaces is an error', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY]), 'https://feed.example.com/other.json': json([GOOD_ENTRY]) }
  const other = [{ snapshots: 'https://feed.example.com/other.json', type: 'pruned' }]
  for (const name of ['denodes', 'DENODES', '  deNodes ']) {
    const { root } = repo({ ...DENODES, 'chains/celestia/mocha-5/intruder.json': contributor(name, other) })
    const { code, out } = await check(root, ['chains/celestia/mocha-5/intruder.json'])
    assert.equal(code, 1, `${name}\n${out}`)
    assert.match(out, /chains\/celestia\/celestia\/deNodes\.json/)
  }
  const { root } = repo({ 'chains/celestia/celestia/a.json': contributor('Test  Nodes'), 'chains/celestia/mocha-5/b.json': contributor('test nodes', [{ snapshots: 'https://feed.example.com/other.json', type: 'pruned' }]) })
  const result = await check(root, ['chains/celestia/mocha-5/b.json'])
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /is also used by chains\/celestia\/celestia\/a\.json/)
})

test('the same contributor in several chain ID folders with one file name and one profile passes', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY]), 'https://feed.example.com/m5.json': json([GOOD_ENTRY]) }
  const { root } = repo({
    ...DENODES,
    'chains/celestia/mocha-5/deNodes.json': contributor('deNodes', [{ snapshots: 'https://feed.example.com/m5.json', type: 'pruned' }])
  })
  const { code, out } = await check(root)
  assert.equal(code, 0, out)
})

test('the same file name with a different profile is an error', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY]), 'https://feed.example.com/m5.json': json([GOOD_ENTRY]) }
  const changed = { ...contributor('deNodes', [{ snapshots: 'https://feed.example.com/m5.json', type: 'pruned' }]), contributor: { name: 'deNodes', website: 'https://evil.example.com' } }
  const { root } = repo({ ...DENODES, 'chains/celestia/mocha-5/deNodes.json': changed })
  const { code, out } = await check(root, ['chains/celestia/mocha-5/deNodes.json'])
  assert.equal(code, 1, out)
  assert.match(out, /contributor differs from the profile in chains\/celestia\/celestia\/deNodes\.json/)
})

test('a feed URL listed by another contributor file is an error', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY]) }
  const { root } = repo({ ...DENODES, 'chains/celestia/mocha-5/testnodes.json': contributor('TestNodes') })
  const { code, out } = await check(root, ['chains/celestia/mocha-5/testnodes.json'])
  assert.equal(code, 1, out)
  assert.match(out, /snapshots\[0\]\.snapshots "https:\/\/feed\.example\.com\/index\.json" is also listed by chains\/celestia\/celestia\/deNodes\.json/)
})

test('--base checks only the files changed on the branch', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY]), 'https://feed.example.com/new.json': json([GOOD_ENTRY]) }
  const { root, g } = repo({
    'chains/celestia/celestia/old.json': contributor('Old'),
    'chains/celestia/celestia/gone.json': contributor('Gone'),
    'chains/celestia/mocha-5/old.json': contributor('Old')
  })
  g(['checkout', '-q', '-b', 'pr'])
  write(root, {
    'chains/celestia/mocha-5/new.json': contributor('New', [{ snapshots: 'https://feed.example.com/new.json', type: 'pruned' }]),
    'chains/celestia/mocha-6/other.json': contributor('Other'),
    'chains/celestia/celestia/notes.txt': 'hello',
    'README.md': '# changed\n'
  })
  rmSync(join(root, 'chains/celestia/celestia/gone.json'))
  g(['add', '-A'])
  g(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'pr'])

  const { code, out } = await check(root, ['--base', 'main'])
  assert.equal(code, 1, out)
  assert.match(out, /changed since main/)
  assert.match(out, /removed {2}chains\/celestia\/celestia\/gone\.json/)
  assert.match(out, /ok {2}chains\/celestia\/mocha-5\/new\.json/)
  assert.match(out, /FAIL {2}chains\/celestia\/mocha-6\/other\.json[\s\S]*chain ID folder "mocha-6", which is not in the registry/)
  assert.match(out, /FAIL {2}chains\/celestia\/celestia\/notes\.txt[\s\S]*not a \.json file/)
  assert.doesNotMatch(out, /old\.json/)
  assert.match(out, /3 contributor files checked, 2 failed/)
})

test('--base fails on a JSON file outside chains/ and ignores other files', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY]) }
  const { root, g } = repo({ 'chains/celestia/celestia/old.json': contributor('Old') })
  g(['checkout', '-q', '-b', 'pr'])
  write(root, {
    'testnodes.json': contributor('TestNodes'),
    'docs/Other.JSON': '{}',
    '.github/ISSUE_TEMPLATE/x.md': 'text',
    'scripts/tool.mjs': '// x',
    'test/case.mjs': '// x',
    'README.md': '# changed\n',
    'CONTRIBUTING.md': '# changed\n',
    'LICENSE': 'text'
  })
  g(['add', '-A'])
  g(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'pr'])
  const { code, out } = await check(root, ['--base', 'main'])
  assert.equal(code, 1, out)
  assert.match(out, /FAIL {2}testnodes\.json[\s\S]*contributor files belong at chains\/<network>\/<chain ID>\/<contributor>\.json/)
  assert.match(out, /FAIL {2}docs\/Other\.JSON/)
  assert.match(out, /2 contributor files checked, 2 failed/)
  assert.doesNotMatch(out, /README|CONTRIBUTING|LICENSE|scripts\/|test\/|\.github/)
})

test('--base with only non-registry changes passes', async () => {
  const { root, g } = repo({ 'chains/celestia/celestia/old.json': contributor('Old') })
  g(['checkout', '-q', '-b', 'pr'])
  write(root, { 'README.md': '# changed\n' })
  g(['add', '-A'])
  g(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'docs'])
  const { code, out } = await check(root, ['--base', 'main'])
  assert.equal(code, 0, out)
  assert.match(out, /No contributor files to check/)
})

test('a given file outside chains/ is an error, not a silent pass', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY]) }
  const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
  const outside = await check(root, ['fx/chains/celestia/celestia/p.json'])
  assert.equal(outside.code, 1, outside.out)
  assert.match(outside.out, /FAIL {2}fx\/chains\/celestia\/celestia\/p\.json[\s\S]*is not a file under chains\/ in this repository/)
  const missing = await check(root, ['chains/celestia/celestia/nope.json'])
  assert.equal(missing.code, 1, missing.out)
  assert.match(missing.out, /path does not exist/)
})

test('given files resolve against the repository root, whatever the current directory', async () => {
  feeds = { [FEED]: json([GOOD_ENTRY]) }
  const { root } = repo({ 'chains/celestia/celestia/p.json': contributor('P') })
  const { code, out } = await check(root, ['chains/celestia/celestia/p.json'])
  assert.notEqual(process.cwd(), root)
  assert.equal(code, 0, out)
  assert.match(out, /1 contributor file checked, 0 failed/)
})

test('a copy of the script in another folder checks the repository given with --root', () => {
  const { root, g } = repo({ 'chains/celestia/celestia/old.json': contributor('Old') })
  g(['checkout', '-q', '-b', 'pr'])
  write(root, { 'testnodes.json': contributor('TestNodes') })
  g(['add', '-A'])
  g(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'pr'])
  const copyDir = mkdtempSync(join(tmpdir(), 'registry-copy-'))
  dirs.push(copyDir)
  const copy = join(copyDir, 'validate.mjs')
  copyFileSync(fileURLToPath(new URL('../scripts/validate.mjs', import.meta.url)), copy)
  const result = spawnSync(process.execPath, [copy, '--root', root, '--base', 'main'], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /FAIL {2}testnodes\.json/)
  assert.match(result.stdout, /1 contributor file checked, 1 failed/)
})

test('--root needs an existing folder', async () => {
  const errors = []
  const err = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try {
    assert.equal(await run(['--root', join(tmpdir(), 'no-such-folder-registry')], undefined, NOW), 2)
    assert.match(errors.join('\n'), /--root/)
  } finally {
    console.error = err
  }
})

test('an unknown base ref is a usage error', async () => {
  const { root } = repo({})
  const errors = []
  const err = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try {
    assert.equal(await run(['--base', 'nope'], root, NOW), 2)
  } finally {
    console.error = err
  }
})
