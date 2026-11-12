---
description: "在现有 Tebra Google Cloud VM 上替换 Harness 运行时，并通过 IAP 部署分支。"
---

# 将 charles-harness 部署到现有 Google Cloud VM

[English](deploy-google-cloud.md) | 中文

<a id="summary"></a>
## 摘要

在现有 Tebra VM 上运行本仓库的 Harness，沿用 Caddy HTTPS 端点、Google 登录、PostgreSQL 数据库、Linux 账号和 Superagent 配置档。本流程遵循 Tebra 的 [VM 设置](https://github.com/mycguo/tebra-superagent/blob/main/docs/015-google-cloud-vm.md)和[分支部署](https://github.com/mycguo/tebra-superagent/blob/main/docs/016-branch-deployment.md)，用 `mycguo/charles-harness` 的源码构建替换已发布的 Harness 可执行程序。

部署操作员负责实机验证。本地测试覆盖临时 Git 仓库、发布切换、回滚和 mock IAP 命令；它们无法验证 VM 访问、已安装插件与本 Harness 版本的兼容性、Google OAuth 或数据库兼容性。启用 Sources 前必须完成切换检查。

<a id="table-of-contents"></a>
## 目录

- [1. 准备现有 VM](#1-prepare-the-existing-vm)
- [2. 构建 Harness](#2-build-the-harness)
- [3. 切换现有服务](#3-switch-the-existing-service)
- [4. 验证切换](#4-verify-the-cutover)
- [5. 部署分支和 PR](#5-deploy-branches-and-prs)
- [恢复与保留的发布](#recovery-and-retained-releases)
- [开发备注](#dev-note)

<a id="1-prepare-the-existing-vm"></a>
## 1. 准备现有 VM

在自己的计算机上使用 Python 3 和已认证的 Google Cloud CLI（命令行界面）。操作员需要 [IAP SSH](https://docs.cloud.google.com/sdk/gcloud/reference/compute/ssh)、OS Login 管理员访问权限，以及 VM 上的免密 `sudo`。以下默认值与 Tebra 部署工具一致：

| 设置 | 值 |
| --- | --- |
| 项目 | `personal-ai-assistant-454604` |
| 可用区 / 实例 | `us-west2-c` / `superagent` |
| HTTPS | `https://superagent.joboffermaster.com` |
| 服务 / 用户 | `tebra-superagent.service` / `superagent` |
| 现有 bundle | `/opt/tebra-superagent` |
| 现有状态和凭据 | `/var/lib/tebra-superagent` |
| Harness 检出目录 | `/opt/charles-harness` |

先检查 VM 状态。已停止的 VM 必须启动后才能使用 SSH。构建此 monorepo 比运行已发布包需要更多内存：VM 至少需要 16 GB RAM、受支持且不低于 24.9 的 Node 24 版本，以及每个候选发布至少 20 GiB 的可用磁盘空间。操作员必须先准备好容量；调整或启动 VM 会影响云费用。

```sh
gcloud compute instances describe superagent \
  --project=personal-ai-assistant-454604 --zone=us-west2-c \
  --format='yaml(status,machineType)'
gcloud compute ssh superagent \
  --project=personal-ai-assistant-454604 --zone=us-west2-c --tunnel-through-iap
```

保留预留 IP、DNS 记录、Caddy 配置、OAuth 回调和 PostgreSQL 连接配置。应用继续监听 `127.0.0.1:3082`；公网入口仍通过 Caddy 的 TCP 80/443。SSH 必须允许 IAP 文档指定的防火墙地址范围访问。本地开发端口 3081 不是此 VM 的代理上游端口。

在已认证的界面中暂停所有 Sources 和处理，等待运行中的 worker 数量归零。启动新运行时前，备份 PostgreSQL、`/var/lib/tebra-superagent`、工单工作区和 `/etc/systemd/system/tebra-superagent.service*`。Harness 升级可能迁移 Session 文件；代码回滚不会撤销持久化更改。禁止让两个协调器同时使用同一数据库 schema。

<a id="2-build-the-harness"></a>
## 2. 构建 Harness

在 VM 管理员 shell 中安装仓库固定版本的 pnpm，并分配新的检出目录。如果 `/opt/charles-harness` 已存在，应停止并检查现有安装，不得覆盖。

```sh
node --version
sudo /usr/local/bin/npm install --prefix /usr/local -g pnpm@11.28.5
sudo test ! -e /opt/charles-harness
sudo install -d -o superagent -g superagent -m 700 /opt/charles-harness
sudo -iu superagent
```

以 `superagent` 身份选择一个已推送且包含此部署设置的分支。沿用 VM 现有的 `gh-agent` 登录和 Git 凭据助手；该账号需要 `mycguo/charles-harness` 的读取权限。构建脚本以此用户的权限访问现有文件和凭据，因此只能部署可信分支。

```sh
BRANCH=your-pushed-branch
~/.local/bin/gh-agent repo clone mycguo/charles-harness /opt/charles-harness \
  -- --single-branch --branch "$BRANCH"
cd /opt/charles-harness
pnpm install --frozen-lockfile
pnpm exec vitest run scripts/deploy-gce.spec.ts --maxWorkers=2
pnpm build
test -f apps/cli/lib/bin.js
test -f apps/web/dist/index.html
DSH_HOME=/var/lib/tebra-superagent/.dsh pnpm dsh --profile superagent --dump-config >/dev/null
exit
```

最后一条命令检查配置档组合，不会启动第二个服务器。不要创建新配置档、重新安装导入的 `third-party/dsh-superagent` 快照、重新设置 Google，或替换现有环境文件。VM 已安装的 Tebra bundle 负责 Google 登录和 PostgreSQL；导入的原型没有这些功能。配置档链接必须继续指向 `/opt/tebra-superagent`，与 Harness 检出目录分开。

<a id="3-switch-the-existing-service"></a>
## 3. 切换现有服务

回到 VM 管理员 shell，检查 `sudo systemctl cat tebra-superagent`。基础 unit 必须保留 `User=superagent`、`HOME=/var/lib/tebra-superagent`、`DSH_HOME=/var/lib/tebra-superagent/.dsh`、私有运行时环境文件及现有优雅停止策略。提供的 [drop-in](../../deploy/google-cloud/charles-runtime.conf) 仅修改工作目录和前台启动命令，通过 `pnpm dsh --profile superagent` 启动。

确认 Sources 已暂停且 worker 空闲后，安装这个新的 drop-in。逐条执行命令，任何命令失败都应停止；如果配置验证失败，保持服务停止。

```sh
sudo test ! -e /etc/systemd/system/tebra-superagent.service.d/charles-runtime.conf
sudo systemctl stop tebra-superagent
sudo install -d -m 755 /etc/systemd/system/tebra-superagent.service.d
sudo install -m 644 /opt/charles-harness/deploy/google-cloud/charles-runtime.conf \
  /etc/systemd/system/tebra-superagent.service.d/charles-runtime.conf
sudo systemctl daemon-reload
sudo systemd-analyze verify tebra-superagent.service
sudo systemctl start tebra-superagent
sudo systemctl status tebra-superagent caddy --no-pager
```

此覆盖配置生效期间，不要运行 Tebra 仓库的部署工具。后续 Harness 发布使用本仓库的工具。现有 bundle 单独固定版本；升级它是独立操作，需要另行检查兼容性。

<a id="4-verify-the-cutover"></a>
## 4. 验证切换

在自己计算机上的本仓库中，检查私有运行时健康状态、此前加载的 Sources、有效的公网 HTTPS、Google 登录页面，以及管理 API 对未登录请求的拒绝：

```sh
./scripts/deploy-gce --branch your-pushed-branch --dry-run
```

首次切换为手动操作，没有自动回滚。如果启动或演练失败，保持 Sources 暂停，并在 VM 管理员 shell 中恢复原先安装包提供的运行时：

```sh
sudo systemctl stop tebra-superagent
sudo rm /etc/systemd/system/tebra-superagent.service.d/charles-runtime.conf
sudo systemctl daemon-reload
sudo systemctl start tebra-superagent
sudo systemctl status tebra-superagent --no-pager
```

部署操作员还必须验证允许的 Google 账号可以登录、其他账号被拒绝、Chat 和 Superagent 能加载、简单模型请求可用，以及工作区 WebSocket 能连接。确认 Google 和 `dsh-auth-*` cookie 带有 `Secure`，并验证未登录访问无法读取管理状态或打开工作区 socket。检查 `sudo ss -ltnp` 显示后端仅绑定回环地址。所有检查通过后才能重新启用 Sources。如果持久化数据发生不兼容更改，返回旧运行时前应恢复切换前的协调备份。

<a id="5-deploy-branches-and-prs"></a>
## 5. 部署分支和 PR

[scripts/deploy-gce](../../scripts/deploy-gce) 沿用 Tebra 的显式本地命令流程。先推送分支。调用方仅通过 IAP 发送工具源码和部署选项；VM 上的 Git 使用现有 `gh-agent` 凭据。无需 Actions 工作流或服务账号密钥，合并 PR（Pull Request）不会触发部署。

```sh
./scripts/deploy-gce --help
./scripts/deploy-gce --branch codex/my-feature --dry-run
./scripts/deploy-gce --branch codex/my-feature
./scripts/deploy-gce --pr 22 --dry-run
./scripts/deploy-gce --pr 22
./scripts/deploy-gce --status
```

替换示例分支或 PR 编号。PR 必须处于打开状态，且头分支属于 `mycguo/charles-harness`；fork 头分支会被拒绝。构建前，工具会比较获取的 SHA 与 GitHub 解析出的 PR 头提交。仅当其他安装使用相同服务和目录布局时，才能覆盖 `--project`、`--zone`、`--instance` 和 `--url`。

只读演练检查现有服务、bundle 链接、干净检出目录、空闲 worker、可用磁盘、健康状态、Google 准入和目标引用。部署以 `superagent` 身份构建独立发布，执行锁定依赖安装、部署专项测试及 `pnpm build`（产物和构建检查）。随后重新检查 worker、记录恢复检查点、切换稳定 Harness 路径、启动同一服务并验证健康状态。构建失败时当前运行时继续运行。激活失败会恢复旧代码并检查健康状态；恢复失败则保留检查点并报告失败。

部署 worker 作为持久 systemd 任务运行，并持有 VM 锁。断开连接不会停止它。检查 `--status`，在 `workerActive` 为 true 时等待。首次自动发布会将初始 Harness 检出目录保留为旧发布。配置档文件、bundle 检出目录、凭据、数据库、会话和工作区均位于 Harness 发布之外。命令接受因设置而暂停的运行时，不会发送模型请求或测试外部 Source 权限；部署后操作员应重复相关切换检查。

合并后，显式部署生成的 `master` 分支：

```sh
./scripts/deploy-gce --branch master
```

<a id="recovery-and-retained-releases"></a>
## 恢复与保留的发布

```sh
./scripts/deploy-gce --rollback --dry-run
./scripts/deploy-gce --rollback
```

当前运行时健康且空闲时，回滚无需重新构建即可恢复上一个 Harness 发布。中断的激活会保留检查点，即使应用不可用，`--rollback` 也能恢复；其演练会拒绝常规预检。回滚仅更改代码，无法撤销 Session 迁移、数据库更改、设置、外部评论或 agent（智能体）文件写入。回滚前应验证数据兼容性，或恢复协调备份。

部署会输出任务 ID、提交和私有日志路径。在 VM 上查看服务日志：

```sh
sudo journalctl -u charles-harness-deploy -n 100 --no-pager
sudo journalctl -u tebra-superagent -n 100 --no-pager
sudo less /var/lib/charles-harness-deploy/JOB_ID.log
```

将 `JOB_ID` 替换为输出的 ID。任务状态和日志由 root 所有，私密保存于 `/var/lib/charles-harness-deploy`。发布积累在 `/opt/charles-harness-releases`，不会自动删除。清理磁盘时，保留 `current`、`previous`、`pending` 或正在部署的候选发布引用的所有路径。日志和备份应作为运维机密保护。

<a id="dev-note"></a>
## 开发备注

无。
