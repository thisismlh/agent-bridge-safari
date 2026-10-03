import { describe, expect, test } from 'claude-code/testing'

import { transportFor } from '../hooks/transport'

describe('transportFor', () => {
  test('window:index ids always mean AppleScript', async () => {
    expect(transportFor('4752:2', true)).toBe('applescript')
  })
  test('numeric ids always mean the extension', async () => {
    expect(transportFor('390', false)).toBe('extension')
    expect(transportFor(390, false)).toBe('extension')
  })
  test('no id follows the connection state', async () => {
    expect(transportFor(undefined, true)).toBe('extension')
    expect(transportFor('', false)).toBe('applescript')
  })
})
