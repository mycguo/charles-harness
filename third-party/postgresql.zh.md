# Superagent PostgreSQL 配置

[English](postgresql.md) | 中文

PostgreSQL 可保存 Superagent 聚合、设置、来源游标及持久化 effect/outbox 队列。DSH Session 日志、工单目录和 worker 配置仍保存在现有本地 DSH 主目录中。PostgreSQL 为可选项；没有 `databaseUrl` 的 profile 继续使用 SQLite。

## 配置与导入

1. 按[本地安装说明](README.zh.md#重新构建软件包)重新构建并安装此快照，然后停止正在运行的 Superagent。备份其状态目录，并在导入时保留同一 `stateDir`。runtime 在打开任一存储前获取该目录的锁。
2. 在仓库中被 Git 忽略的 `.env` 内设置 `DB_PASSWORD=<实际密码>`。`dsh` 启动器会加载此文件。不要把密码放入 YAML、shell 参数、Git 或 PR。
3. 从 **Database settings → SSL Configuration** 下载公开的 Supabase CA 证书，保存到 DSH host 可读的绝对路径。[Supabase SSL 说明](https://supabase.com/docs/guides/platform/ssl-enforcement)介绍了经过验证的连接。
4. 将以下配置字段合并到 `~/.dsh_charles/profiles/superagent/cordis.patch.yml` 现有的 `dsh-superagent` 条目中，并替换证书路径：

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

5. 从仓库根目录启动：

```sh
DSH_HOME="$HOME/.dsh_charles" pnpm dsh --profile superagent --host 127.0.0.1 --port 3081
```

导入器以只读快照读取 `<stateDir>/orchestrator.sqlite`，要求 schema 11。它在一个 PostgreSQL 事务中复制全部九张存储表，保留插入顺序和队列 generation，然后记录完成标记。非空目标会被拒绝。导入中断或失败会回滚已复制的行；SQLite 源文件保持不变。同一路径的已完成导入在重启时不会重复执行。检查面板和设置后，删除 `databaseImportSqlite` 或将其设为 `false`，使后续启动不再依赖源路径。

## 运行与恢复

使用 PostgreSQL 直连或 session 模式连接池。transaction 模式连接池无法保留此存储的会话锁。Supabase 直连通常需要 IPv6；仅支持 IPv4 的 host 应使用项目的 session 连接池 URL。数据库角色需要创建专用 schema、表和索引的权限。不要通过 Supabase Data API 暴露该 schema。

`databasePasswordEnv` 默认为 `DB_PASSWORD`；名称必须包含 `KEY`、`PASSWORD`、`SECRET` 或 `TOKEN`，以便 DSH 从 worker 子进程环境中移除它。URL 不包含密码（也接受提供的 `[YOUR-PASSWORD]` 占位符）；host 对环境变量值进行百分号编码。TLS 验证默认为 `verify-full`；`sslrootcert` 指定自定义 CA。本地 PostgreSQL 等部署可显式指定其他 SSL 模式。数据库配置变更会重新挂载插件。

每个 schema 只允许一个写入者，由连接持有直至关闭的 PostgreSQL advisory lock 强制保证。专用 worker 执行查询并保留同步聚合事务 API；网络查询会阻塞调用者，直到收到响应或超过 `databaseTimeoutMs`。连接丢失会永久停用该存储实例，报告写入结果可能未知，并要求检查数据库后重启。它不会自动重连、重试写入或回退至 SQLite。

切换后备份 PostgreSQL。保留的 SQLite 文件是导入前的副本：PostgreSQL 接收新写入后移除 `databaseUrl` 会恢复陈旧数据。目前没有 PostgreSQL 到 SQLite 的导出或同步功能。

## 验证

在 `third-party/dsh-superagent` 中运行：

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/tsdown/dist/run.mjs
```

PostgreSQL 测试在 macOS/Linux 上通过私有 Unix socket 启动临时原生服务器。它们比较 SQLite 与 PostgreSQL 的读写行为，验证导入回滚和重启，并检查独占所有权与连接丢失后的故障隔离。Windows 跳过该 Unix-socket fixture。实测 Supabase 时，将 `SUPERAGENT_TEST_DATABASE_URL` 设为不含密码且启用验证的连接 URL，将 `SUPERAGENT_TEST_ENV_FILE` 设为 `.env` 的绝对路径，再运行 `node node_modules/vitest/vitest.mjs run tests/postgres.spec.ts --testTimeout=120000 --hookTimeout=60000`（网络往返需要更大的用例时间预算）。每次运行使用随机临时 schema 并在清理时删除它；不会导入正在运行的应用数据。
