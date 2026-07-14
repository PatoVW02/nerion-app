import { describe, expect, it } from 'vitest'
import { getVirtualWindow } from './virtual-list'

describe('virtual list window', () => {
  it('renders only visible rows plus overscan', () => {
    expect(getVirtualWindow(10_000, 2_800, 280, 28, 5)).toEqual({
      start: 95,
      end: 115,
      offsetTop: 2_660,
      totalHeight: 280_000,
    })
  })

  it('clamps empty and end-of-list windows safely', () => {
    expect(getVirtualWindow(0, 100, 300, 28, 5)).toEqual({ start: 0, end: 0, offsetTop: 0, totalHeight: 0 })
    expect(getVirtualWindow(10, 10_000, 280, 28, 4)).toEqual({ start: 10, end: 10, offsetTop: 280, totalHeight: 280 })
  })
})
