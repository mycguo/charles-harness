/** A dedicated transport worker owns one PostgreSQL session until close. */
import pg from 'pg'
import { parentPort } from 'node:worker_threads'
import { runAsWorker } from 'synckit'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'

/** Cloneable requests accepted only from the aggregate store. */
export interface Request { kind: 'open' | 'query' | 'close'; url?: string; timeoutMs?: number; sql?: string; values?: SQLInputValue[] }
/** Only SQLSTATE leaves the worker on failure; URLs, passwords, SQL parameters, and server details stay private. */
export interface Response { rows: Record<string, SQLOutputValue>[]; changes: number; error?: string; fatal?: boolean }

/** Owns the worker connection, its terminal failure state, and socket shutdown. */
class Connection {
  private entry?: { client: pg.Client; failed: boolean }
  async request(request: Request): Promise<Response> {
    const empty: Response = { rows: [], changes: 0 }
    if (request.kind === 'close') {
      const entry = this.entry
      this.entry = undefined
      if (entry) await entry.client.end()
      // Stop accepting requests; Synckit sends this reply through its separate MessagePort.
      parentPort?.close()
      return empty
    }
    if (request.kind === 'open') {
      const client = new pg.Client({ connectionString: request.url, connectionTimeoutMillis: request.timeoutMs,
        statement_timeout: request.timeoutMs, query_timeout: request.timeoutMs,
        types: { getTypeParser: oid => oid === 20 ? (value: string) => {
          const number = Number(value)
          if (!Number.isSafeInteger(number)) throw new Error('PostgreSQL integer exceeds safe range')
          return number
        } : pg.types.getTypeParser(oid) } })
      const entry = { client, failed: false }
      client.on('error', () => { entry.failed = true })
      this.entry = entry
      try { await client.connect(); return empty }
      catch (error) { await client.end(); this.entry = undefined; return { ...empty, error: state(error), fatal: true } }
    }
    const entry = this.entry
    if (!entry || entry.failed) return { ...empty, error: 'CONNECTION_LOST', fatal: true }
    try {
      const result = await entry.client.query<Record<string, SQLOutputValue>>(request.sql!, request.values)
      if (Array.isArray(result)) return empty
      return { rows: result.rows, changes: result.rowCount ?? 0 }
    } catch (error) {
      const code = state(error)
      const fatal = entry.failed || !/^[0-9A-Z]{5}$/.test(code) || code.startsWith('08') || code.startsWith('57P')
      if (fatal) { entry.failed = true; await entry.client.end() }
      return { ...empty, error: code, fatal }
    }
  }
}
function state(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'CONNECTION_FAILED'
}
const connection = new Connection()
runAsWorker((request: Request) => connection.request(request))
