// Shim: SearchClient calls Rust API instead of SQLite directly
const API = process.env.HQ_API_URL ?? 'http://localhost:5678';

export class SearchClient {
  constructor(_vaultPath: string) {}

  async keywordSearch(query: string, limit = 20) {
    try {
      const res = await fetch(`${API}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
      if (res.ok) return (await res.json()).results ?? [];
    } catch {}
    return [];
  }

  async hybridSearch(query: string, _embedding: any, limit = 20) {
    return this.keywordSearch(query, limit);
  }

  getStats() { return { ftsCount: 0, embeddingCount: 0 }; }
  close() {}
}
