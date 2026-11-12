/** Select the configured persistence backend before the runtime reads or writes any aggregate. */
import { join } from 'node:path'
import type { Machine } from '../deployment.ts'
import { Store } from './store.ts'
import { DatabaseError, PostgresDatabase, importSqlite } from './postgres.ts'

/** Resolve the database password from the host environment; profile configuration contains no secret.
 * @param connection - PostgreSQL URL with no password or the documented placeholder.
 * @param name - Credential-shaped environment variable name, normally DB_PASSWORD.
 * @param environment - Host environment; injectable for tests.
 * @returns Connection URL with encoded credentials and verified TLS by default; explicit SSL options are retained.
 */
export function databaseUrl(connection: string, name: string, environment: NodeJS.ProcessEnv = process.env): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !/KEY|PASSWORD|SECRET|TOKEN/i.test(name)) throw new DatabaseError('The PostgreSQL environment variable name must contain KEY, PASSWORD, SECRET, or TOKEN so worker subprocesses do not inherit it.', 'SUPERAGENT_DATABASE_CONFIG')
  const password = environment[name]
  let url: URL
  try { url = new URL(connection) } catch { throw new DatabaseError('Set databaseUrl to a PostgreSQL connection URL.', 'SUPERAGENT_DATABASE_CONFIG') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || (url.password && !['[YOUR-PASSWORD]', '%5BYOUR-PASSWORD%5D'].includes(url.password))) {
    throw new DatabaseError('Use a PostgreSQL URL without a password; put the password in the configured host environment variable.', 'SUPERAGENT_DATABASE_CONFIG')
  }
  if (!password || password === '[YOUR-PASSWORD]') throw new DatabaseError(`Set ${name} to the actual database password.`, 'SUPERAGENT_DATABASE_CONFIG')
  url.password = encodeURIComponent(password)
  if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'verify-full')
  return url.toString()
}

/** Open SQLite by default, or PostgreSQL when databaseUrl is set; configured failures never fall back.
 * @param machine - Deployment configuration, including the state directory protected by the caller's lock.
 * @param report - Reports failed post-commit callbacks.
 * @returns Owned store; the caller closes it after every store consumer has stopped.
 */
export function openStore(machine: Machine, report: (error: unknown) => void): Store {
  const path = join(machine.stateDir, 'orchestrator.sqlite')
  if (!machine.databaseUrl) return new Store(path, report)
  const store = new Store(new PostgresDatabase(databaseUrl(machine.databaseUrl, machine.databasePasswordEnv ?? 'DB_PASSWORD'), machine.databaseTimeoutMs ?? 30000, machine.databaseSchema ?? 'dsh_superagent'), report)
  try {
    if (machine.databaseImportSqlite) importSqlite(store, path)
    return store
  } catch (error) { store.close(); throw error }
}
