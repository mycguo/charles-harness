import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { PostgresDatabase, importSqlite } from '../src/app/postgres.ts'
import { databaseUrl } from '../src/app/open-store.ts'
import { Config, machineOf } from '../src/deployment.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import type { Thread, Ticket, Trigger } from '../src/core/index.ts'

it('validates password references, encodes passwords, and never puts a secret in diagnostics', () => {
  const connection = 'postgresql://postgres@example.com/db'
  for (const password of [undefined, '', '[YOUR-PASSWORD]']) {
    expect(() => databaseUrl(connection, 'DB_PASSWORD', { DB_PASSWORD: password })).toThrowError(expect.objectContaining({ code: 'SUPERAGENT_DATABASE_CONFIG' }))
  }
  expect(() => databaseUrl(connection, 'DATABASE_URL', {})).toThrow('must contain')
  for (const value of ['invalid', 'https://postgres@example.com/db', 'postgresql://postgres:secret@example.com/db']) {
    expect(() => databaseUrl(value, 'DB_PASSWORD', { DB_PASSWORD: 'secret' })).toThrowError(expect.objectContaining({ code: 'SUPERAGENT_DATABASE_CONFIG' }))
  }
  const result = new URL(databaseUrl(connection, 'DB_PASSWORD', { DB_PASSWORD: 'a%/#?@ :b' }))
  expect(decodeURIComponent(result.password)).toBe('a%/#?@ :b')
  expect(result.searchParams.get('sslmode')).toBe('verify-full')
  expect(databaseUrl(connection + '?sslmode=disable', 'DB_PASSWORD', { DB_PASSWORD: 'secret' })).toContain('sslmode=disable')
  expect(() => machineOf(Config({ stateDir: '/tmp/state', databaseImportSqlite: true }))).toThrow('requires databaseUrl')
})

// Each process owns a private Unix socket directory, so concurrent runs share neither ports nor databases.
describe.skipIf(process.platform === 'win32')('PostgreSQL store over a native PostgreSQL connection', () => {
  let directory: string
  let server: EmbeddedPostgres
  let admin: pg.Client
  let url: string
  const schema = `dsh_superagent_test_${randomBytes(6).toString('hex')}`
  const stores: Store[] = []
  const open = () => { const store = new Store(new PostgresDatabase(url, 30000, schema)); stores.push(store); return store }
  beforeAll(async () => {
    directory = mkdtempSync('/tmp/dsh-pg-')
    const live = process.env.SUPERAGENT_TEST_DATABASE_URL
    if (live) {
      const envFile = process.env.SUPERAGENT_TEST_ENV_FILE
      if (!envFile) throw new Error('Live tests require SUPERAGENT_TEST_ENV_FILE containing DB_PASSWORD')
      url = databaseUrl(live, 'DB_PASSWORD', parseEnv(readFileSync(envFile, 'utf8')))
      admin = new pg.Client({ connectionString: url, connectionTimeoutMillis: 30000 })
      await admin.connect()
      return
    }
    server = new EmbeddedPostgres({ databaseDir: join(directory, 'data'), port: 5432, user: 'postgres', password: 'test',
      persistent: true, autoRehydrateSymlinks: true, postgresFlags: ['-c', "listen_addresses=", '-c', `unix_socket_directories=${directory}`],
      onLog: () => {}, onError: () => {} })
    await server.initialise()
    await server.start()
    admin = new pg.Client({ host: directory, port: 5432, user: 'postgres', password: 'test', database: 'postgres' })
    await admin.connect()
    url = `postgresql://postgres:test@localhost/postgres?host=${encodeURIComponent(directory)}&sslmode=disable`
  }, 60000)
  beforeEach(async () => { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) })
  afterEach(() => { for (const store of stores.splice(0)) store.close() })
  afterAll(async () => {
    try { if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end() } }
    finally { try { if (server) await server.stop() } finally { if (directory) rmSync(directory, { recursive: true, force: true }) } }
  }, 60000)

  it('persists across reopen, rolls back nested writes, and runs callbacks only after commit', () => {
    const store = open(), calls: string[] = []
    store.atomic(() => {
      store.set('kept', 1)
      expect(() => store.atomic(() => { store.set('discarded', 2); store.afterCommit(() => calls.push('discarded')); throw new Error('rollback') })).toThrow('rollback')
      store.afterCommit(() => calls.push('kept'))
      expect(calls).toEqual([])
    })
    expect(calls).toEqual(['kept'])
    expect(() => store.atomic(() => { store.set('outer', 1); throw new Error('rollback') })).toThrow('rollback')
    store.close()
    const reopened = open()
    expect(reopened.get('kept')).toBe(1)
    expect(reopened.get('discarded')).toBeUndefined()
    expect(reopened.get('outer')).toBeUndefined()
  })

  it('holds exclusive ownership until close and never reconnects after connection loss', async () => {
    const store = open()
    expect(() => open()).toThrow('Could not open')
    const pid = store.db.prepare('SELECT pg_backend_pid() AS pid').get()!.pid
    await admin.query('SELECT pg_terminate_backend($1)', [pid])
    expect(() => store.get('x')).toThrowError(expect.objectContaining({ code: 'SUPERAGENT_DATABASE_FAILED' }))
    expect(() => store.set('x', 1)).toThrow('unavailable')
    store.close()
    expect(open().get('x')).toBeUndefined()
  })

  const seed = (store: Store) => {
    const thread: Thread = { key: 'github:1', ref: { source: 'github', id: '1' }, createdAt: '1', subscriptions: ['t'], correlated: [], pending: ['a'], meta: {} }
    store.threads.save(thread)
    const ticket: Ticket = { id: 't', title: 'Ticket', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
      channels: [], assignments: [], inputs: [], undelivered: ['input'], createdAt: '1', updatedAt: '1', origin: { triggerId: 'a', triggerIds: ['a'] } }
    store.tickets.save(ticket)
    const trigger: Trigger = { id: 'a', source: 'github', threads: [thread.ref], actor: { source: 'github', id: 'alice' }, human: true, at: '2', text: 'literal % _ ? \\ text', meta: {}, url: 'https://github.com/example/repo/issues/1' }
    store.triggers.save(trigger)
    store.triggers.save({ ...trigger, id: 'b', at: '1', human: false, meta: { ci: {} } })
    store.triggers.saveDisposition('b', { filtered: { code: 'test' }, fanout: [], at: '1' })
    store.decisions.save({ id: 'd', kind: 'ignore', threadKey: thread.key, triggerIds: ['a'], at: '2', reason: [{ code: 'test' }], evalId: 'e', policyVersion: '', strength: 'explicit' })
    store.set('family/%_?', { text: 'value' })
    store.saveSettings({})
    store.receipts.add({ id: 'm', channel: { source: 'github', thread: '1', address: { number: '1' } }, text: 'reply', kind: 'reply', ticketId: 't' })
    store.receipts.add({ id: 'm2', channel: { source: 'github', thread: '1', address: { number: '1' } }, text: 'next', kind: 'reply', ticketId: 't' })
    store.receipts.add({ id: 'dropped', channel: { source: 'github', thread: '1', address: { number: '1' } }, text: 'old', kind: 'reply' })
    store.receipts.settle(store.receipts.get('dropped')!, 'channelGone')
    const effects = new Effects(store, new HealthBoard())
    effects.enqueue('reply', 'm', {})
    store.db.prepare("UPDATE effect SET attempts = 3, error = 'failed' WHERE key = ?").run('m')
  }
  const read = (store: Store) => ({
    kv: store.get('family/%_?'), keys: store.keys('family/'), threads: store.threads.list(), activeThreads: store.threads.active(),
    tickets: store.tickets.list(), open: store.tickets.open(), active: store.tickets.active(), decisions: store.decisions.byThread('github:1'),
    recent: store.read.recentTriggers(), stats: store.read.triggerStats('0'), flow: store.read.flow('0'),
    triggers: store.read.triggers({ source: 'github' }), filtered: store.read.triggers({ filtered: true }),
    timeline: store.read.threadTriggers('github:1'), bounded: store.read.threadTriggers('github:1', 50, { at: '2', id: 'a' }),
    through: store.read.threadTriggers('github:1', 50, { at: '2', id: 'a' }, true), page: store.read.threadPage('github:1', 0, 20),
    neighbours: store.read.neighbours('github:1', '3', 'z'), first: store.read.firstTrigger('github:1', true),
    search: store.read.search('% _ ? \\'), url: store.read.search('https://github.com/'), exact: store.read.search('a'),
    recentDecisions: store.read.recentDecisions(), decisionPage: store.read.decisions({ kinds: ['ignore'], since: '0' }, 0, 20),
    kinds: store.read.decisionsOfKinds(['ignore']), failing: store.read.failingReplies(), dropped: store.read.droppedReplies(),
    droppedSince: store.read.droppedSince('0'), subscribed: store.read.subscribedThreads(), github: store.read.subscribedThreads('github'),
    receipts: store.receipts.waiting(), behind: store.receipts.behind('m2', 4), status: store.replyStatus('m'),
    settings: store.settings(), settingsHistory: store.settingsHistory(),
  })

  it('imports every table once, preserving query results, insertion order, and source bytes', () => {
    const path = join(directory, 'source.sqlite'), sqlite = new Store(path)
    stores.push(sqlite)
    seed(sqlite)
    sqlite.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const hash = () => createHash('sha256').update(readFileSync(path)).digest('hex')
    const original = hash(), store = open()
    importSqlite(store, path)
    expect(read(store)).toEqual(read(sqlite))
    importSqlite(store, path)
    expect(hash()).toBe(original)
    expect(store.get(KV.store.schema)).toBe(sqlite.get(KV.store.schema))
    store.close()
    expect(read(open())).toEqual(read(sqlite))
  })

  it('matches SQLite writes, generated working sets, receipts, and effect dispatch after import', async () => {
    const sqlite = new Store(join(directory, 'parity.sqlite')), store = open()
    stores.push(sqlite)
    seed(sqlite)
    importSqlite(store, join(directory, 'parity.sqlite'))
    for (const db of [store, sqlite]) {
      db.threads.patchMeta('github:1', { updated: true })
      db.threads.describe('github:1', { label: 'Updated' })
      db.triggers.save({ ...db.triggers.get('a')!, text: 'updated' })
      db.tickets.save({ ...db.tickets.get('t')!, undelivered: [] })
      db.receipts.settle(db.receipts.get('m')!, 'sent')
      expect(db.receipts.withdraw('m2')).toBe(true)
      expect(db.receipts.add(db.receipts.get('m')!)).toBe(false)
      db.delete('family/%_?')
      const effects = new Effects(db, new HealthBoard()), sent: string[] = []
      effects.handle('reply', async (_, id) => { sent.push(id) })
      effects.start()
      await effects.idle()
      await effects.drain()
      expect(sent).toEqual(['m'])
      expect(effects.pending('reply')).toBe(false)
    }
    expect(read(store)).toEqual(read(sqlite))
  })

  it('refuses a nonempty target and rolls back a failed import without changing SQLite', () => {
    const path = join(directory, 'invalid.sqlite'), sqlite = new Store(path)
    stores.push(sqlite)
    seed(sqlite)
    const store = open()
    store.set('existing', 'preserved')
    expect(() => importSqlite(store, path)).toThrow('empty PostgreSQL')
    expect(store.get('existing')).toBe('preserved')
    store.delete('existing')
    // A malformed record after earlier tables have copied must roll the whole import back.
    sqlite.db.prepare('UPDATE outbox SET value = ? WHERE id = ?').run('null', 'm2')
    sqlite.db.prepare('INSERT INTO effect(kind,key,value,seq,due,since) VALUES (?,?,?,?,?,?)').run('bad', 'bad', 'test', 1, 9223372036854775807n, '0')
    expect(() => importSqlite(store, path)).toThrow()
    expect(store.triggers.get('a')).toBeUndefined()
    expect(store.get('postgres/sqlite-import')).toBeUndefined()
    expect(sqlite.triggers.get('a')).toBeDefined()
  })
})
