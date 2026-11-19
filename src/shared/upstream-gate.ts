/** Per-origin backoff: healthy traffic is immediate; only penalties schedule a wait. */
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
  private cooldownMs = 0;
  private readonly initialMs: number;
  private readonly minMs: number;
  private readonly maxMs: number;

  constructor(name: string, opts: UpstreamGateOptions = {}) {
    this.name = name;
    this.minMs = opts.minMs ?? 4_000;
    this.maxMs = opts.maxMs ?? 60_000;
    this.initialMs = opts.initialMs ?? 10_000;
  }

  get cooldown(): number {
    return this.cooldownMs;
  }

  async wait(): Promise<number> {
    let waited = 0;
    // Another in-flight request may extend the deadline while we are asleep.
    while (this.nextOkAt > Date.now()) {
      const delay = this.nextOkAt - Date.now();
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      waited += delay;
    }
    return waited;
  }

  reward(): void {
    this.successes += 1;
    // Do not erase a penalty imposed by another in-flight request.
    if (Date.now() >= this.nextOkAt) this.cooldownMs = 0;
  }

  penalize(): void {
    this.hits += 1;
    this.cooldownMs = Math.min(this.maxMs, Math.max(this.minMs,
      this.cooldownMs ? Math.round(this.cooldownMs * 1.5) : this.initialMs));
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
