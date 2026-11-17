import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeReturnTo } from '../../src/lib/auth/paths.ts'
import { normalizeName } from '../../src/lib/auth/name.ts'
test('returnTo accepts only implemented local application destinations', () => {
  for (const path of ['/matches', '/matches/new', '/account'])
    assert.equal(safeReturnTo(path), path)
  for (const path of [
    'https://evil.invalid',
    '//evil.invalid',
    '/\\evil',
    '/login',
    '/signup',
    '/password/update',
    '/auth/confirm',
    '/profile/setup',
    '/matches?next=evil',
    '/matches#evil',
    '/matches\n',
    '/%2f%2fevil.invalid',
    '/%252f%252fevil.invalid',
    '/matches/../login',
    '',
  ])
    assert.equal(safeReturnTo(path), '/matches')
})
test('display name uses the same Unicode fixtures as Go', () => {
  const cases = [
    ['あ', 'あ'],
    ['あ'.repeat(30), 'あ'.repeat(30)],
    ['あ'.repeat(31), null],
    ['　 A😀 あ 　', 'A😀 あ'],
    ['Player', 'Player'],
    ['', null],
    ['　 ', null],
    ['\n名前', null],
    ['名前\r', null],
    ['名\t前', null],
    ['名\u0085前', null],
    ['名\u2028前', null],
    ['名\u2029前', null],
    ['\u2007名前\u202f', '名前'],
    ['\ufeff名前\ufeff', '\ufeff名前\ufeff'],
    ['e\u0301', 'e\u0301'],
  ]
  for (const [input, expected] of cases)
    assert.equal(normalizeName(input), expected)
})
