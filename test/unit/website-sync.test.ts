/**
 * The website's /redeem console cannot import from the Safe App (its Turbopack root is
 * pinned to website/), so it carries copies of the chain config. These must stay
 * byte-identical: a network added to the app but not the console would let a Safe
 * sign a delegation its payee cannot redeem.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '../..')
const SYNCED = ['networks.ts', 'supported-chains.ts', 'addresses.ts']

describe('website /redeem config mirrors the app', () => {
  for (const file of SYNCED) {
    test(file, () => {
      const app = readFileSync(join(ROOT, 'src/config', file), 'utf8')
      const site = readFileSync(join(ROOT, 'website/src/redeem/config', file), 'utf8')
      expect(site).toBe(app)
    })
  }
})
