export { SearchClient } from './search';
export class TraceDB {
  constructor(_vaultPath: string) {}
  async getTraces() { return []; }
  async getTrace(_id: string) { return null; }
}
