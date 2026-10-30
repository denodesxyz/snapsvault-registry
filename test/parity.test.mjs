// Checks that scripts/validate.mjs applies exactly the rules of the app's src/lib/validation/feed.ts.
// Run with the path to feed.ts from the app repository (denodesxyz/snapsvault):
//   FEED_TS=../snapsvault/src/lib/validation/feed.ts node --test test/parity.test.mjs
// Node 22.18 or later runs the TypeScript file directly; older Node 22 needs --experimental-strip-types.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ours from '../scripts/validate.mjs'
import { BODIES, CONTRIBUTORS, DIRS, ENDPOINTS, ENTRIES, NAMES, NOW } from './vectors.mjs'

const FEED_TS = process.env.FEED_TS
const app = FEED_TS ? await import(pathToFileURL(resolve(FEED_TS)).href) : null
const skip = app ? false : 'set FEED_TS to the app feed.ts to run the parity test'

const SAME = [
  ['validateSnapshotEntry', ENTRIES, v => [v, NOW]],
  ['validateContributor', CONTRIBUTORS, v => [v]],
  ['validateSnapshotEndpoint', ENDPOINTS, v => [v]],
  ['validateRegistryFileName', NAMES, v => [v]],
  ['validateDirectoryName', DIRS, v => [v]],
  ['validateFeedUrl', ENTRIES.map(e => e?.url), v => [v]],
  ['validateContributorLink', CONTRIBUTORS.flatMap(c => [c?.website, c?.logoUrl, c?.x]), v => [v]],
  ['validateFilename', ENTRIES.map(e => e?.filename), v => [v]],
  ['safeFilenameFromUrl', ENTRIES.map(e => e?.url), v => [v]]
]

for (const [fn, vectors, args] of SAME) {
  test(`${fn} agrees with the app on ${vectors.length} inputs`, { skip }, () => {
    let accepted = 0
    vectors.forEach((v, i) => {
      const expected = app[fn](...args(v))
      assert.deepEqual(ours[fn](...args(v)), expected, `${fn} input #${i}: ${JSON.stringify(v)?.slice(0, 120)}`)
      if (expected === null || expected?.ok === false) return
      accepted++
    })
    console.log(`# ${fn}: ${vectors.length} inputs, ${accepted} accepted, ${vectors.length - accepted} rejected, identical results`)
  })
}

test(`readFeedJson agrees with the app on ${BODIES.length} bodies`, { skip }, async () => {
  for (const [label, body, length] of BODIES) {
    const make = () => new Response(body, { headers: length ? { 'content-length': length } : {} })
    const outcome = async impl => {
      try {
        return { value: await impl.readFeedJson(make()) }
      } catch (error) {
        return { error: error.name, message: error.message.replace(/ in JSON at position \d+.*$/, '') }
      }
    }
    assert.deepEqual(await outcome(ours), await outcome(app), label)
  }
})

test('exported limits match the app', { skip }, () => {
  for (const name of ['MAX_URL_LENGTH', 'MAX_FEED_BYTES', 'MAX_FEED_ENTRIES', 'FEED_TIMEOUT_MS']) {
    assert.equal(ours[name], app[name], name)
  }
})

test('checkHeightZero(entry, effectiveType) matches the app', { skip }, t => {
  if (typeof app.checkHeightZero !== 'function') {
    t.skip('the app feed.ts has no checkHeightZero export yet')
    return
  }
  const heights = [undefined, 0, 1, 15093969]
  const types = ['archive', 'pruned', 'snapshot', '', undefined]
  let compared = 0
  for (const type of types) {
    for (const height of heights) {
      const entry = height === undefined ? {} : { latest_block_height: height }
      const theirs = app.checkHeightZero(entry, type)
      const mine = ours.checkHeightZero(entry, type)
      assert.equal(mine.ok, theirs.ok, `type ${type} height ${height}`)
      if (!mine.ok) {
        assert.equal(typeof theirs.reason, 'string', `app reason, type ${type} height ${height}`)
        assert.equal(typeof mine.reason, 'string', `our reason, type ${type} height ${height}`)
      }
      compared++
    }
  }
  console.log(`# checkHeightZero: ${compared} combinations, identical verdicts`)
})
