/** Per-origin cooldown. First call is immediate; later calls wait out the last reward/penalize. */
export interface UpstreamGateOptions {
  initialMs?: number;
  minMs?: number;
  maxMs?: number;
}

export class UpstreamGate {
  readonly name: string;
  hits = 0;
  successes = 0;
  private nextOkAt = 0;
  private cooldownMs: number;
  private readonly minMs: number;
  private readonly maxMs: number;

  constructor(name: string, opts: UpstreamGateOptions = {}) {
    this.name = name;
    this.minMs = opts.minMs ?? 4_000;
    this.maxMs = opts.maxMs ?? 60_000;
    this.cooldownMs = opts.initialMs ?? 10_000;
  }

  get cooldown(): number {
    return this.cooldownMs;
  }

  async wait(): Promise<number> {
    const delay = Math.max(0, this.nextOkAt - Date.now());
    if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
    return delay;
  }

  reward(): void {
    this.successes += 1;
    this.cooldownMs = Math.max(this.minMs, Math.round(this.cooldownMs * 0.8));
    this.schedule();
  }

  penalize(): void {
    this.hits += 1;
    this.cooldownMs = Math.min(this.maxMs, Math.round(this.cooldownMs * 1.5));
    this.schedule();
  }

  private schedule(): void {
    this.nextOkAt = Date.now() + this.cooldownMs;
  }
}

const gates = new Map<string, UpstreamGate>();

export function getUpstreamGate(name: string, opts?: UpstreamGateOptions): UpstreamGate {
  const existing = gates.get(name);
  if (existing) return existing;
  const created = new UpstreamGate(name, opts);
  gates.set(name, created);
  return created;
}

export function resetUpstreamGates(): void {
  gates.clear();
}
