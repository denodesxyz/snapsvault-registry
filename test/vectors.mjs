// Shared inputs for the parity and validator tests.

export const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)

const SHA = 'db174c6a5d7b419e7d623df5e291ba428c0f6775fd0e4cbb766f76589e5bcdbb'
const base = { url: 'https://snap.example.com/celestia/celestia_15093969.tar.lz4' }
const withField = (field, value) => ({ ...base, [field]: value })

export const ENTRIES = [
  // shape
  null, 'text', 42, [], {},
  base,
  { url: 'https://celestia-mainnet-snap.denodes.xyz/celestia-mainnet_15093969.tar.bz2', period: '4h', type: 'pruned', tx_index: false, size: '15Gb', creation_date: '2026-10-19T09:37:14Z', latest_block_height: '15093969', sha256sum: SHA },
  // url and download_url
  { download_url: base.url }, { url: '', download_url: base.url }, { url: null }, { url: 'http://snap.example.com/a.tar' },
  { url: 'https://snap.example.com:443/a.tar' }, { url: 'https://user:pw@snap.example.com/a.tar' }, { url: 'https://snap.example.com/a.tar#x' },
  { url: 'https://127.0.0.1/a.tar' }, { url: 'https://localhost/a.tar' }, { url: 'https://box.local/a.tar' }, { url: 'https://box.internal/a.tar' },
  { url: 'https://snap.example.com./a.tar' }, { url: 'https://example/a.tar' }, { url: 'https://snap.example.123/a.tar' }, { url: 'https://xn--bcher-kva.example/a.tar' },
  { url: 'https://snap.example.com/a b.tar' }, { url: 'https://snap.example.com/$(id).tar' }, { url: 'https://snap.exa%6Dple.com/a.tar' },
  { url: 'HTTPS://snap.example.com/a.tar' }, { url: `https://snap.example.com/${'a'.repeat(2050)}.tar` }, { url: 42 },
  { url: 'https://snap.example.com/' }, { url: 'https://snap.example.com/dir/?file=a.tar' }, { url: 'https://Snap.Example.com/a.tar' },
  // filename
  withField('filename', 'snapshot.tar.lz4'), withField('filename', '.hidden'), withField('filename', 'a..b'), withField('filename', 'a/b'),
  withField('filename', 'x'.repeat(201)), withField('filename', 5), withField('filename', ''), withField('filename', null),
  // size
  withField('size', '426Gb'), withField('size', '426G'), withField('size', '1.2T'), withField('size', '3.4 GiB'), withField('size', '3.4  GiB'),
  withField('size', '123456789'), withField('size', '0GB'), withField('size', '0.5GB'), withField('size', 0), withField('size', -1),
  withField('size', 15.5), withField('size', Infinity), withField('size', '15 Gb '), withField('size', '15XB'), withField('size', '1234567890123456'),
  withField('size', 'x'.repeat(25)), withField('size', true),
  // heights
  withField('latest_block_height', '15093969'), withField('latest_block_height', 15093969), withField('latest_block_height', 0), withField('latest_block_height', '0'),
  withField('latest_block_height', -1), withField('latest_block_height', 1.5), withField('latest_block_height', '12a'), withField('latest_block_height', '1234567890123456'),
  withField('latest_block_height', 2 ** 53), withField('block_height', '77'), withField('height', 88), { ...base, latest_block_height: '1', block_height: 'bad' },
  { ...base, latest_block_height: '', block_height: '5' },
  // dates
  withField('creation_date', '2026-10-19T09:37:14Z'), withField('creation_date', '2026-10-19T09:37:14.000Z'), withField('creation_date', '2026-10-19T09:37Z'),
  withField('creation_date', '2026-10-19T09:37:14+02:00'), withField('creation_date', '2026-10-19T09:37:14+0200'), withField('creation_date', '2026-10-19T09:37:14'),
  withField('creation_date', '2026-10-19'), withField('creation_date', '2026-02-30T00:00:00Z'), withField('creation_date', '2026-10-19T24:00:00Z'),
  withField('creation_date', '2018-12-31T23:59:59Z'), withField('creation_date', '2026-10-21T12:00:00Z'), withField('creation_date', '2026-10-20T11:00:00Z'),
  withField('creation_date', 1760000000), withField('time', '2026-10-01T00:00:00Z'), { ...base, creation_date: '2026-10-01T00:00:00Z', time: 'bad' },
  // sha256
  withField('sha256sum', SHA), withField('sha256sum', SHA.toUpperCase()), withField('sha256sum', SHA.slice(1)), withField('sha256sum', `sha256:${SHA}`),
  withField('checksum', { sha256: SHA }), withField('checksum', { sha256: 'bad' }), withField('checksum', 'bad'), withField('checksum', []), withField('checksum', { md5: 'x' }),
  { ...base, sha256sum: SHA, checksum: { sha256: SHA.replace(/d/g, 'e') } },
  // labels and tx_index
  withField('type', 'pruned'), withField('type', 'archive'), withField('type', 'Pruned!'), withField('type', 'x'.repeat(33)), withField('type', 7),
  withField('period', '4h'), withField('period', '4 h'), withField('tx_index', true), withField('tx_index', 'false'), withField('tx_index', 'yes'), withField('tx_index', 1),
  // unknown keys are ignored
  withField('compression', 'lz4')
]

export const CONTRIBUTORS = [
  null, [], 'deNodes', {}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(65) }, { name: 'ok\u200bname' }, { name: 'tab\tname' }, { name: 42 },
  { name: '  deNodes  ' },
  { name: 'deNodes', email: 'hello@denodes.io', discord: 'bombermine', telegram: 'https://t.me/denodes', x: 'https://x.com/denodes_io', description: 'line one\nline two', website: 'https://denodes.io', identity: 'C89053F92B77D8C0', logoUrl: 'https://cdn.example.com/logo.png#v2' },
  { name: 'Bad', email: 'not-an-email', discord: 'https://discord.gg/abc', telegram: 'http://t.me/x', x: 'x.com/abc', website: 'https://site.example.com/#about', identity: 'XYZ', logoUrl: 'https://1.2.3.4/logo.png', description: 'y'.repeat(501) },
  { name: 'Empty', email: '', website: null, identity: '' }
]

export const ENDPOINTS = [
  null, [], {}, { snapshots: '' }, { snapshots: 'https://feed.example.com/index.json' },
  { snapshots: 'https://feed.example.com/index.json', type: 'pruned', period: '4h', tx_index: false },
  { snapshots: 'https://feed.example.com/index.json', type: 'pruned', period: '4h', tx_index: 'true' },
  { snapshots: 'https://feed.example.com/index.json#x' }, { snapshots: 'http://feed.example.com/index.json' },
  { snapshots: 'https://feed.example.com/index.json', type: 'pruned archive' }, { snapshots: 'https://feed.example.com/index.json', period: '' },
  { snapshots: 'https://feed.example.com/index.json', tx_index: 'yes' }, { snapshots: 42 }
]

export const NAMES = ['deNodes.json', 'my-contributor.json', 'a.json', '.json', '...json', 'x.JSON', 'bad name.json', `${'a'.repeat(100)}.json`, `${'a'.repeat(101)}.json`, 'a.b.json', 'ü.json', 42]
export const DIRS = ['celestia', 'mocha-5', 'mocha_4', 'a b', '', 'x'.repeat(64), 'x'.repeat(65), '..', null]

// Feed bodies for readFeedJson: [label, body bytes or string, content-length header or null]
export const BODIES = [
  ['array', '[{"url":"https://a.example.com/a.tar"}]', null],
  ['empty array', '[]', null],
  ['object', '{"url":"x"}', null],
  ['invalid json', '[{', null],
  ['bad utf-8', new Uint8Array([0x5b, 0x22, 0xff, 0x22, 0x5d]), null],
  ['declared too large', '[]', '2000000'],
  ['streamed too large', `[${'"x",'.repeat(300000)}"x"]`, null],
  ['exactly 1 MiB', `[${' '.repeat(1_048_576 - 2)}]`, null],
  ['empty body', '', null]
]
