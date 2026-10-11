/**
 * Cache di memori dengan masa berlaku dan batas jumlah entri.
 * Tanpa timer: entri kedaluwarsa dibuang saat diakses, entri tertua dibuang saat penuh.
 */
export class TtlCache<K, V> {
  private store = new Map<K, { value: V; expires: number }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 500) {}

  get(key: K): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: K, value: V): void {
    this.store.delete(key);
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  delete(key: K): void {
    this.store.delete(key);
  }
}
