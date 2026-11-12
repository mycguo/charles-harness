/** Synchronous statements used by the aggregate store and durable effect queue. */
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'

/** PostgreSQL bridges queries to a worker; SQLite executes them on the caller. */
export interface StoreDatabase {
  readonly dialect?: 'postgres'
  exec(sql: string): void
  prepare(sql: string): {
    all(...values: SQLInputValue[]): Record<string, SQLOutputValue>[]
    get(...values: SQLInputValue[]): Record<string, SQLOutputValue> | undefined
    run(...values: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  }
  close(): void
}

/** Convert the store's fixed SQLite query vocabulary to PostgreSQL; parameters remain bound values.
 * @param sql - SQL authored in Store, storeReads or Effects, never user input.
 * @returns PostgreSQL SQL with positional bindings and native JSON expressions.
 */
export function postgresSql(sql: string): string {
  const path = (value: string) => value.slice(2).split('.').join(',')
  let result = sql
    .replace(/json_each\(json_extract\((\w+\.value), '\$\.triggerIds'\)\) j/g,
      "jsonb_array_elements_text($1::jsonb #> '{triggerIds}') AS j(value)")
    .replace(/json_extract\(([\w.]+), '(\$\.[^']+)'\)/g, (_, column: string, field: string) => `(${column}::jsonb #>> '{${path(field)}}')`)
    .replace(/([\w.]+) ->> '(\$\.[^']+)'/g, (_, column: string, field: string) => `(${column}::jsonb #>> '{${path(field)}}')`)
    .replace(/json_patch\(value, \?\)/g, '((value::jsonb || ?::jsonb)::text)')
    .replace(/\bIFNULL\(/g, 'COALESCE(')
    .replace(/ INDEXED BY thread_subscribed/g, '')
    .replace(/generation = generation \+ 1/g, 'generation = effect.generation + 1')
  if (result.includes('INSERT OR IGNORE')) result = result.replace('INSERT OR IGNORE', 'INSERT') + ' ON CONFLICT DO NOTHING'
  // Quoted SQL literals can contain question marks; only unquoted placeholders are numbered.
  let index = 0
  result = result.replace(/'(?:[^']|'')*'|\?/g, token => token === '?' ? `$${++index}` : token)
  return result
}
