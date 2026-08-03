/**
 * DESIGN §16.5: axe exceptions are reviewed records, never an inline `.disableRules()`.
 * Keep this list small. Every entry needs a concrete rationale and an ISO-date expiry;
 * an expired entry fails the suite even if axe still reports the same violation.
 */
export interface AxeException {
  rule: string
  target: string
  rationale: string
  expires: string
}

export const AXE_ALLOWLIST: readonly AxeException[] = []
