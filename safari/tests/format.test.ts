import { describe, expect, test } from 'claude-code/testing'

import { explainSafariError, formatFind, formatTabs, formatTree, parseKey, parseKeys, parseTabId } from '../hooks/format'

describe('parseTabId', () => {
  test('empty means current tab', async () => {
    expect(parseTabId(undefined)).toBe(null)
    expect(parseTabId('')).toBe(null)
  })
  test('parses window and index', async () => {
    expect(parseTabId('4752:2')).toEqual({ windowId: 4752, tabIndex: 2 })
  })
  test('rejects other shapes', async () => {
    expect(() => parseTabId('abc')).toThrow(/tabs_context/)
  })
})

describe('parseKey', () => {
  test('named keys map to key codes', async () => {
    expect(parseKey('Return')).toEqual({ modifiers: [], keyCode: 36 })
    expect(parseKey('cmd+shift+Tab')).toEqual({ modifiers: ['command down', 'shift down'], keyCode: 48 })
  })
  test('characters are keystrokes', async () => {
    expect(parseKey('cmd+a')).toEqual({ modifiers: ['command down'], char: 'a' })
  })
  test('sequences split on spaces', async () => {
    expect(parseKeys('Backspace Backspace Delete').map(k => k.keyCode)).toEqual([51, 51, 117])
  })
  test('unknown keys are refused with a hint', async () => {
    expect(() => parseKey('Ctl+x')).toThrow(/Unknown modifier/)
    expect(() => parseKey('Bogus')).toThrow(/Unknown key/)
  })
})

describe('formatting', () => {
  test('tabs list marks the active tab', async () => {
    const out = formatTabs([{ windowId: 1, tabs: [{ tabId: '1:1', url: 'https://a', title: 'A', active: false }, { tabId: '1:2', url: 'https://b', title: '', active: true }] }])
    expect(out).toContain('Window 1:')
    expect(out).toContain('* 1:2  (untitled)  https://b')
    expect(out).toContain('  1:1  A  https://a')
  })
  test('tree truncates to max_chars', async () => {
    const out = formatTree({ url: 'u', title: 't', lines: Array.from({ length: 100 }, (_, i) => `line ${i}`) }, 200)
    expect(out.length).toBeLessThan(260)
    expect(out).toContain('truncated')
  })
  test('find rows carry ref, role and name', async () => {
    expect(formatFind([{ ref: 'ref_3', role: 'link', name: 'Docs', href: 'https://d' }])).toBe('ref_3  link "Docs" https://d')
    expect(formatFind([])).toBe('No matching elements.')
  })
})

describe('explainSafariError', () => {
  test('names the Develop menu setting', async () => {
    expect(explainSafariError("Safari got an error: You must enable 'Allow JavaScript from Apple Events' ...")).toContain('Develop > "Allow JavaScript from Apple Events"')
  })
  test('stale tab ids point at tabs_context', async () => {
    expect(explainSafariError("Can't get window 1. Invalid index. (-1719)")).toContain('tabs_context')
  })
  test('other messages lose the osascript prefix', async () => {
    expect(explainSafariError('12:34: execution error: boom (8)')).toBe('boom')
  })
})
