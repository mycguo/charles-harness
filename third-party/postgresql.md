# Superagent PostgreSQL setup

English | [中文](postgresql.zh.md)

Use PostgreSQL for Superagent aggregates, settings, source cursors and the durable effect/outbox queues. DSH Session logs, ticket directories and worker configuration remain under the existing local DSH home. PostgreSQL is optional; profiles without `databaseUrl` continue using SQLite.

## Configure and import

1. Rebuild and install this snapshot with the [local installation instructions](README.md#rebuild-the-package), then stop the running Superagent. Back up its state directory and keep the same `stateDir` for the import. The runtime acquires that directory's lock before opening either store.
2. Put `DB_PASSWORD=<actual-password>` in the repository's ignored `.env`. The `dsh` launcher loads this file. Do not put the password in YAML, a shell argument, Git or a PR.
3. Download the public Supabase CA certificate from **Database settings → SSL Configuration**. Save it to an absolute path readable by the DSH host. [Supabase's SSL instructions](https://supabase.com/docs/guides/platform/ssl-enforcement) describe verified connections.
4. Merge these configuration fields into the existing `dsh-superagent` entry in `~/.dsh_charles/profiles/superagent/cordis.patch.yml`, replacing the certificate path:

```yaml
- id: dsh-superagent
  config:
    stateDir: /Users/master/.dsh_charles/state/superagent-prototype
    databaseUrl: postgresql://postgres@db.cxskrbaiyjcyqvwjqrsj.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/absolute/path/prod-ca-2021.crt
    databasePasswordEnv: DB_PASSWORD
    databaseSchema: dsh_superagent
    databaseImportSqlite: true
    databaseTimeoutMs: 30000
```

5. Start from the repository root:

```sh
DSH_HOME="$HOME/.dsh_charles" pnpm dsh --profile superagent --host 127.0.0.1 --port 3081
```

The importer reads `<stateDir>/orchestrator.sqlite` in a read-only snapshot and requires schema 11. It copies all nine store tables in one PostgreSQL transaction, retaining insertion order and queue generations, then records a completion marker. It refuses a nonempty destination. An interrupted or rejected import rolls back its rows; the SQLite source stays unchanged. A completed import from the same path is a no-op on restart. After checking the panel and settings, remove `databaseImportSqlite` or set it to `false` so later starts no longer need the source path.

## Operation and recovery

Use a direct PostgreSQL connection or a session-mode pooler. Transaction-mode poolers cannot retain this store's session lock. Supabase direct connections normally require IPv6; use the project's session-pooler URL if the host only has IPv4. The database role needs permission to create its dedicated schema, tables and indexes. Do not expose that schema through the Supabase Data API.

`databasePasswordEnv` defaults to `DB_PASSWORD`; its name must contain `KEY`, `PASSWORD`, `SECRET` or `TOKEN` so DSH removes it from worker subprocess environments. The URL contains no password (the supplied `[YOUR-PASSWORD]` placeholder is also accepted); the host percent-encodes the environment value. TLS verification defaults to `verify-full`; `sslrootcert` supplies a custom CA. An explicit SSL mode is retained for deployments such as local PostgreSQL. Database configuration changes remount the plugin.

Each schema has one writer, enforced by a PostgreSQL advisory lock held on the connection until close. A dedicated worker performs queries while preserving the synchronous aggregate transaction API; network queries block the caller until a reply or `databaseTimeoutMs`. A lost connection permanently disables that store instance, reports possible unknown write outcomes, and requires restart after checking the database. It never reconnects, retries a write or falls back to SQLite automatically.

Back up PostgreSQL after cutover. The retained SQLite file is a pre-import copy: removing `databaseUrl` after PostgreSQL has received writes would restore stale data. There is no PostgreSQL-to-SQLite export or synchronization.

## Verification

Run inside `third-party/dsh-superagent`:

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/tsdown/dist/run.mjs
```

The PostgreSQL tests start a disposable native server with a private Unix socket on macOS/Linux. They compare SQLite and PostgreSQL reads and writes, exercise import rollback and restart, and verify exclusive ownership and connection-loss containment. Windows skips this Unix-socket fixture. For a live Supabase run, set `SUPERAGENT_TEST_DATABASE_URL` to the passwordless verified connection URL and `SUPERAGENT_TEST_ENV_FILE` to the absolute `.env` path, then run `node node_modules/vitest/vitest.mjs run tests/postgres.spec.ts --testTimeout=120000 --hookTimeout=60000` (network round trips need a larger case budget). Each run uses a random temporary schema and removes it on teardown; it does not import the running application's data.
