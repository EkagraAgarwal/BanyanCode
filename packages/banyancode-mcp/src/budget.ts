// Per-task budget caps: steps, USD cost, and wall-clock. Pure evaluation so
// the engine can call it from event handlers, checkup, and timers with the
// same semantics, and tests can pin the arithmetic without a server.

export const DEFAULT_MAX_STEPS = 200

export type BudgetInput = {
  max_steps?: number | undefined
  max_cost?: number | undefined
  timeout_s?: number | undefined
}

export type Budget = {
  maxSteps: number
  maxCost: number
  timeoutMs: number
}

export type BudgetUsage = {
  steps: number
  cost: number
  startedAt: number
  now: number
}

export type BudgetExceeded = {
  reason: "steps" | "cost" | "timeout"
  detail: string
}

export const parseBudget = (input: BudgetInput | undefined, defaults: { maxCost: number }): Budget => {
  const maxSteps =
    input?.max_steps !== undefined && Number.isFinite(input.max_steps) && input.max_steps > 0
      ? Math.floor(input.max_steps)
      : DEFAULT_MAX_STEPS
  const maxCost =
    input?.max_cost !== undefined && Number.isFinite(input.max_cost) && input.max_cost >= 0
      ? input.max_cost
      : defaults.maxCost
  const timeoutMs =
    input?.timeout_s !== undefined && Number.isFinite(input.timeout_s) && input.timeout_s > 0
      ? Math.floor(input.timeout_s * 1000)
      : 0
  return { maxSteps, maxCost, timeoutMs }
}

// First tripped cap wins; a non-positive cap disables that dimension.
export function evaluateBudget(budget: Budget, usage: BudgetUsage): BudgetExceeded | undefined {
  if (usage.steps > budget.maxSteps) {
    return {
      reason: "steps",
      detail: `task exceeded its step cap (${usage.steps} > ${budget.maxSteps})`,
    }
  }
  // Strictly greater: a cap of 0 with zero spend is not a trip.
  if (usage.cost > budget.maxCost) {
    return {
      reason: "cost",
      detail: `task exceeded its USD cap of $${budget.maxCost} (spent $${usage.cost.toFixed(4)})`,
    }
  }
  if (budget.timeoutMs > 0 && usage.now - usage.startedAt > budget.timeoutMs) {
    return {
      reason: "timeout",
      detail: `task exceeded its ${Math.round(budget.timeoutMs / 1000)}s timeout`,
    }
  }
  return undefined
}

export * as BudgetCaps from "./budget"
