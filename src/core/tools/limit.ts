/**
 * Pembatas jumlah pekerjaan berat yang berjalan bersamaan.
 * `tryRun` menolak (mengembalikan null) saat penuh, sehingga permintaan tidak menumpuk di memori.
 */
export class Semaphore {
  private active = 0;

  constructor(private readonly max: number) {}

  get busy(): boolean {
    return this.active >= this.max;
  }

  async tryRun<T>(job: () => Promise<T>): Promise<{ value: T } | null> {
    if (this.busy) return null;
    this.active++;
    try {
      return { value: await job() };
    } finally {
      this.active--;
    }
  }
}

/** Jeda minimal antar permintaan per kunci (mis. per user). Entri lama dibuang otomatis. */
export class Cooldown {
  private last = new Map<number | string, number>();

  constructor(private readonly ms: number) {}

  /** Mengembalikan 0 jika boleh lanjut (dan mencatat waktunya), atau sisa detik jika harus menunggu. */
  hit(key: number | string): number {
    const now = Date.now();
    const prev = this.last.get(key) ?? 0;
    if (now - prev < this.ms) return Math.ceil((this.ms - (now - prev)) / 1000);

    if (this.last.size > 2000) {
      for (const [k, t] of this.last) if (now - t >= this.ms) this.last.delete(k);
    }
    this.last.set(key, now);
    return 0;
  }
}

/** Seperti Promise.all + map, tetapi paling banyak `limit` pekerjaan berjalan bersamaan. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
