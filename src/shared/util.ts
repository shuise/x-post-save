export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 均匀随机延迟，用于拟人化节奏。 */
export function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randomDelay(min: number, max: number): Promise<void> {
  return sleep(randomBetween(min, max));
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}