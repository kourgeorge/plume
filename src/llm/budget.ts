import { getGlobalDb, getGlobalSetting as getSetting, setGlobalSetting as setSetting } from '../db';
import { log } from '../log';

/** Monthly spending limit for model calls across all sites, in US dollars. 0 = no limit. */
export const DEFAULT_BUDGET_USD = Number(process.env.PLUME_MONTHLY_BUDGET_USD ?? 50);

export class BudgetExceeded extends Error {
  constructor(public spent: number, public limit: number) {
    super(`Monthly AI budget reached ($${spent.toFixed(2)} of $${limit.toFixed(2)}). Raise it under Settings, or wait for next month.`);
  }
}

export function monthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function budgetLimit(): number {
  return getSetting<number>('monthlyBudgetUsd', DEFAULT_BUDGET_USD);
}

export function setBudgetLimit(usd: number): void {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('budget must be zero (no limit) or a positive number of dollars');
  setSetting('monthlyBudgetUsd', usd);
}

export function spentThisMonth(now = new Date()): number {
  const r = getGlobalDb().prepare('SELECT COALESCE(SUM(cost_usd), 0) s FROM llm_calls WHERE at >= ?').get(monthStart(now)) as { s: number };
  return r.s;
}

export interface BudgetStatus {
  limit: number;
  spent: number;
  remaining: number | null;
  /** First day of next month, when the count starts again. */
  resets: string;
}

export function budgetStatus(now = new Date()): BudgetStatus {
  const limit = budgetLimit();
  const spent = spentThisMonth(now);
  const resets = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return { limit, spent, remaining: limit ? Math.max(0, limit - spent) : null, resets };
}

/** Called before every model call. Throws once the month's limit is reached; warns once at 80%. */
export function checkBudget(purpose: string, now = new Date()): void {
  const { limit, spent } = budgetStatus(now);
  if (!limit) return;
  if (spent >= limit) throw new BudgetExceeded(spent, limit);
  const month = monthStart(now).slice(0, 7);
  if (spent >= limit * 0.8 && getSetting<string>('budgetWarned', '') !== month) {
    setSetting('budgetWarned', month);
    log('warn', 'budget', `AI spending is at $${spent.toFixed(2)} of the $${limit.toFixed(2)} monthly limit (80%). Last call: ${purpose}.`);
  }
}
