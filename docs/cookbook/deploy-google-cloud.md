---
description: "Replace the Harness runtime on the existing Tebra Google Cloud VM and deploy branches through IAP."
---

# Deploy charles-harness to the existing Google Cloud VM

English | [中文](deploy-google-cloud.zh.md)

<a id="summary"></a>
## Summary

Run this repository's Harness on the existing Tebra VM, with the same Caddy HTTPS endpoint, Google sign-in, PostgreSQL database, Linux account, and Superagent profile. This procedure follows Tebra's [VM setup](https://github.com/mycguo/tebra-superagent/blob/main/docs/015-google-cloud-vm.md) and [branch deployment](https://github.com/mycguo/tebra-superagent/blob/main/docs/016-branch-deployment.md), replacing the published Harness executable with a source build of `mycguo/charles-harness`.

The deployment operator owns live verification. Local tests exercise temporary Git repositories, release switches, rollback, and mocked IAP commands; they cannot verify VM access, the installed plugin's compatibility with this Harness version, Google OAuth, or database compatibility. Complete the cutover checks before enabling Sources.

<a id="table-of-contents"></a>
## Table of Contents

- [1. Prepare the existing VM](#1-prepare-the-existing-vm)
- [2. Build the Harness](#2-build-the-harness)
- [3. Switch the existing service](#3-switch-the-existing-service)
- [4. Verify the cutover](#4-verify-the-cutover)
- [5. Deploy branches and PRs](#5-deploy-branches-and-prs)
- [Recovery and retained releases](#recovery-and-retained-releases)
- [Dev Note](#dev-note)

<a id="1-prepare-the-existing-vm"></a>
## 1. Prepare the existing VM

Use Python 3 and an authenticated Google Cloud CLI on your computer. The operator needs [IAP SSH](https://docs.cloud.google.com/sdk/gcloud/reference/compute/ssh), OS Login administrator access, and passwordless `sudo` on the VM. These defaults match the Tebra deployment tool:

| Setting | Value |
| --- | --- |
| Project | `personal-ai-assistant-454604` |
| Zone / instance | `us-west2-c` / `superagent` |
| HTTPS | `https://superagent.joboffermaster.com` |
| Service / user | `tebra-superagent.service` / `superagent` |
| Existing bundle | `/opt/tebra-superagent` |
| Existing state and credentials | `/var/lib/tebra-superagent` |
| Harness checkout | `/opt/charles-harness` |

Check VM status first. A stopped VM must be started before SSH works. Building this monorepo needs more memory than running the published package: use a VM with at least 16 GB RAM, a supported Node 24 release at or above 24.9, and at least 20 GiB of free disk for each candidate. The operator must arrange capacity before continuing; resizing or starting the VM can change cloud charges.

```sh
gcloud compute instances describe superagent \
  --project=personal-ai-assistant-454604 --zone=us-west2-c \
  --format='yaml(status,machineType)'
gcloud compute ssh superagent \
  --project=personal-ai-assistant-454604 --zone=us-west2-c --tunnel-through-iap
```

Retain the reserved IP, DNS record, Caddy configuration, OAuth callback, and PostgreSQL connection configuration. Keep the application on `127.0.0.1:3082`; public ingress remains TCP 80/443 through Caddy. SSH must be reachable through IAP's documented firewall range. The local development port 3081 is not this VM's proxy upstream.

Pause all Sources and processing in the authenticated UI, then wait for zero running workers. Back up PostgreSQL, `/var/lib/tebra-superagent`, ticket workspaces, and `/etc/systemd/system/tebra-superagent.service*` before starting the new runtime. A Harness upgrade can migrate Session files; code rollback does not undo persisted changes. Never run two coordinators against the same database schema.

<a id="2-build-the-harness"></a>
## 2. Build the Harness

In the administrator VM shell, install pnpm at the repository's pinned version and allocate a fresh checkout directory. Stop if `/opt/charles-harness` already exists; inspect that installation instead of overwriting it.

```sh
node --version
sudo /usr/local/bin/npm install --prefix /usr/local -g pnpm@11.28.5
sudo test ! -e /opt/charles-harness
sudo install -d -o superagent -g superagent -m 700 /opt/charles-harness
sudo -iu superagent
```

As `superagent`, select a pushed branch containing this deployment setup. Keep the VM's existing `gh-agent` login and Git credential helper; that account needs read access to `mycguo/charles-harness`. Build scripts run with this user's access to existing files and credentials, so deploy only trusted branches.

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

The last command checks profile composition without starting a second server. Do not create a fresh profile, reinstall the imported `third-party/dsh-superagent` snapshot, run Google setup again, or replace existing environment files. The VM's installed Tebra bundle owns Google sign-in and PostgreSQL; the imported prototype lacks those features. Keep its profile link pointing to `/opt/tebra-superagent`, independently of the Harness checkout.

<a id="3-switch-the-existing-service"></a>
## 3. Switch the existing service

Back in the administrator VM shell, inspect `sudo systemctl cat tebra-superagent`. The base unit must retain `User=superagent`, `HOME=/var/lib/tebra-superagent`, `DSH_HOME=/var/lib/tebra-superagent/.dsh`, the private runtime environment file, and the existing graceful-stop policy. The supplied [drop-in](../../deploy/google-cloud/charles-runtime.conf) changes only the working directory and foreground launch command. It launches through `pnpm dsh --profile superagent`.

After confirming Sources are paused and workers are idle, install this fresh drop-in. Run each command separately and stop on any failure; keep the service stopped if configuration validation fails.

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

Do not run the Tebra repository's deployment tool while this override is active. Subsequent Harness releases use this repository's tool. The existing bundle remains pinned separately; upgrading it is a separate operation requiring its own compatibility checks.

<a id="4-verify-the-cutover"></a>
## 4. Verify the cutover

From this repository on your computer, check private runtime health, the previously loaded Sources, valid public HTTPS, the Google sign-in page, and signed-out management API rejection:

```sh
./scripts/deploy-gce --branch your-pushed-branch --dry-run
```

The initial switch is manual and has no automatic rollback. If startup or the dry run fails, keep Sources paused and restore the original packaged runtime in the administrator VM shell:

```sh
sudo systemctl stop tebra-superagent
sudo rm /etc/systemd/system/tebra-superagent.service.d/charles-runtime.conf
sudo systemctl daemon-reload
sudo systemctl start tebra-superagent
sudo systemctl status tebra-superagent --no-pager
```

The deployment operator must also verify an allowed Google account can sign in, another account is denied, Chat and Superagent load, a small model request works, and the workspace WebSocket connects. Confirm `Secure` on Google and `dsh-auth-*` cookies, and verify signed-out access cannot read management state or open a workspace socket. Check `sudo ss -ltnp` shows the backend bound only to loopback. Re-enable Sources only after these checks pass. If persisted data changed incompatibly, restore the coordinated pre-cutover backup before returning to the previous runtime.

<a id="5-deploy-branches-and-prs"></a>
## 5. Deploy branches and PRs

[scripts/deploy-gce](../../scripts/deploy-gce) uses the same explicit, local-command process as Tebra. Push the branch first. The caller sends only this tool's source and deployment options through IAP; VM Git uses the existing `gh-agent` credentials. No Actions workflow or service-account key is required, and merging a PR does not deploy it.

```sh
./scripts/deploy-gce --help
./scripts/deploy-gce --branch codex/my-feature --dry-run
./scripts/deploy-gce --branch codex/my-feature
./scripts/deploy-gce --pr 22 --dry-run
./scripts/deploy-gce --pr 22
./scripts/deploy-gce --status
```

Replace the example branch or PR number. PRs must be open with a head branch in `mycguo/charles-harness`; fork heads are rejected. The tool checks the fetched SHA against GitHub's resolved PR head before building. Override `--project`, `--zone`, `--instance`, and `--url` only for an installation with the same service and directory layout.

The read-only dry run checks the existing service, bundle link, clean checkout, idle workers, free disk, health, Google admission, and target ref. Deployment builds a separate release as `superagent`, running the locked install, focused deployment tests, and `pnpm build` (artifacts plus build checks). It rechecks workers, records a recovery checkpoint, switches the stable Harness path, starts the same service, and verifies health. A build failure leaves the current runtime running. Failed activation restores the previous code and checks health; failed recovery retains the checkpoint and reports failure.

The worker is a durable systemd job with a VM lock. Disconnecting does not stop it. Inspect `--status` and wait while `workerActive` is true. The first automated rollout retains the initial Harness checkout as a legacy release. Profile files, bundle checkout, credentials, database, sessions, and workspaces remain outside Harness releases. The command accepts a setup-paused runtime and does not send model requests or test external Source permissions; the operator repeats the relevant cutover checks after deployment.

After merging, explicitly deploy the resulting `master` branch:

```sh
./scripts/deploy-gce --branch master
```

<a id="recovery-and-retained-releases"></a>
## Recovery and retained releases

```sh
./scripts/deploy-gce --rollback --dry-run
./scripts/deploy-gce --rollback
```

Rollback restores the previous Harness release without rebuilding, provided the current runtime is healthy and idle. An interrupted activation retains a checkpoint that `--rollback` can recover even when the app is unavailable; its dry run refuses normal preflight. Rollback changes code only. It cannot reverse Session migrations, database changes, settings, external comments, or agent file writes. Verify data compatibility before rollback or restore the coordinated backup.

The deployment prints its job ID, commit, and private log path. Inspect service logs on the VM:

```sh
sudo journalctl -u charles-harness-deploy -n 100 --no-pager
sudo journalctl -u tebra-superagent -n 100 --no-pager
sudo less /var/lib/charles-harness-deploy/JOB_ID.log
```

Replace `JOB_ID` with the printed ID. Job state and logs are root-owned and private under `/var/lib/charles-harness-deploy`. Releases accumulate under `/opt/charles-harness-releases`; nothing automatically removes them. Preserve all paths referenced by `current`, `previous`, `pending`, or an active candidate when reclaiming disk space. Protect logs and backups as operational secrets.

<a id="dev-note"></a>
## Dev Note

None.
