import { expect, test } from 'bun:test'
import {
  applyDraftRequest, consumeDraftRequest, getDraftRequest, requestDraft,
} from './composerStore'

test('a request names the session it is for, and carries a stamp', () => {
  requestDraft('s1', '/tdd ')
  const first = getDraftRequest()
  expect(first?.sessionId).toBe('s1')
  requestDraft('s1', '/tdd ')
  // The same text asked twice is two requests, or the composer could obey only the first.
  expect(getDraftRequest()).not.toBe(first)
})

test('the draft is APPENDED to, never replaced', () => {
  expect(applyDraftRequest('', '/tdd ')).toBe('/tdd ')
  expect(applyDraftRequest('faz isso', '/tdd ')).toBe('faz isso /tdd ')
  expect(applyDraftRequest('faz isso ', '/tdd ')).toBe('faz isso /tdd ')
  expect(applyDraftRequest('linha\n', '/tdd ')).toBe('linha\n/tdd ')
})

test('a taken request is CLEARED, so a remount cannot apply it again', () => {
  requestDraft('s2', '/frontend-design ')
  const at = getDraftRequest()!.at
  consumeDraftRequest(at)
  expect(getDraftRequest()).toBeNull()
})

test('a late consumer cannot clear a NEWER request it never applied', () => {
  requestDraft('s3', '/one ')
  const old = getDraftRequest()!.at
  // Time moves; a second ask lands before the first was consumed.
  requestDraft('s3', '/two ')
  const fresh = getDraftRequest()!
  consumeDraftRequest(old)
  expect(getDraftRequest()).toBe(fresh)
})
