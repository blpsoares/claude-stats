import { expect, test, describe } from 'bun:test'
import { effortColor, effortSteps, orderEfforts } from './effortScale'

describe('orderEfforts', () => {
  test('weakest to strongest, whatever order the harness listed them in', () => {
    expect(orderEfforts(['high', 'low', 'medium'])).toEqual(['low', 'medium', 'high'])
    expect(orderEfforts(['max', 'minimal'])).toEqual(['minimal', 'max'])
  })

  test('an unrecognised level keeps the harness own order rather than being alphabetised', () => {
    // The CLI lists them in the order it considers meaningful. Re-sorting would assert an order
    // nobody established, and this scale may only ever decorate a set the harness really accepts.
    expect(orderEfforts(['zeta', 'alpha'])).toEqual(['zeta', 'alpha'])
  })

  test('unrecognised levels sort after every known one', () => {
    expect(orderEfforts(['custom', 'low'])).toEqual(['low', 'custom'])
  })

  test('an empty set stays empty — a harness with no effort flag is asked nothing', () => {
    expect(orderEfforts([])).toEqual([])
  })
})

describe('effortSteps', () => {
  test('intensity runs 0 to 1 across the levels offered', () => {
    const steps = effortSteps(['low', 'medium', 'high'])
    expect(steps.map(s => s.value)).toEqual(['low', 'medium', 'high'])
    expect(steps.map(s => s.intensity)).toEqual([0, 0.5, 1])
  })

  test('only the strongest is the peak', () => {
    expect(effortSteps(['low', 'medium', 'high']).map(s => s.peak)).toEqual([false, false, true])
  })

  test('a single level IS the maximum — full intensity, and the peak', () => {
    // Otherwise the only level a harness offers would render as the weakest possible setting.
    expect(effortSteps(['high'])).toEqual([{ value: 'high', intensity: 1, peak: true }])
  })

  test('two levels span the whole ramp, same as five', () => {
    expect(effortSteps(['low', 'high']).map(s => s.intensity)).toEqual([0, 1])
  })
})

describe('effortColor', () => {
  test('green at the bottom, red at the top', () => {
    expect(effortColor(0)).toBe('hsl(142, 72%, 48%)')
    expect(effortColor(1)).toBe('hsl(0, 72%, 48%)')
  })

  test('clamps rather than producing a hue outside the ramp', () => {
    expect(effortColor(-1)).toBe(effortColor(0))
    expect(effortColor(9)).toBe(effortColor(1))
  })
})
