# 本地 Superagent 安装

[English](README.md) | 中文

原始 DeepSeek Superagent 原型的源码副本位于 [dsh-superagent](dsh-superagent/README.md)。[dsh-superagent.source.json](dsh-superagent.source.json) 记录上游提交和源码树。此快照保留全部 216 个上游文件及 MIT 许可证；源码记录列出本地改动，包括需主动启用的单账号模式移植。此快照位于 Harness pnpm 工作区之外，使用自己锁定的依赖。

`~/.dsh_charles` 下的 `superagent` 配置档使用此快照打包后的安装副本，不依赖 `~/dev/tebra-superagent`。其独立状态目录为 `~/.dsh_charles/state/superagent-prototype`。

## 启动或重启

先停止现有进程，然后在 Harness 仓库根目录运行：

```sh
DSH_HOME="$HOME/.dsh_charles" pnpm dsh --profile superagent --host 127.0.0.1 --port 3081
```

应用会打开端口 3081 上带身份验证信息的浏览器地址。在 **Settings → Models** 中配置模型，在 **Superagent → Settings → Sources → GitHub** 中配置仓库。新建的原型目前报告尚未配置 GitHub 仓库；部署设置完成后，它会创建自己管理的聊天工作区。

## 重新构建软件包

在 `third-party/dsh-superagent` 内运行：

```sh
pnpm --ignore-workspace --config.manage-package-manager-versions=false install --frozen-lockfile
node node_modules/typescript/bin/tsc --noEmit
node node_modules/tsdown/dist/run.mjs
pnpm --ignore-workspace --config.manage-package-manager-versions=false pack --pack-destination ../../.artifacts/superagent
```

然后停止应用，在 Harness 仓库根目录运行以下命令。先移除旧软件包，因为替换相同版本时可能保留原来的安装：

```sh
DSH_HOME="$HOME/.dsh_charles" pnpm dsh plugin --profile superagent remove dsh-superagent
DSH_HOME="$HOME/.dsh_charles" pnpm dsh plugin --profile superagent add file:"$PWD/.artifacts/superagent/dsh-superagent-0.1.0.tgz"
```

使用上面的启动命令重启。配置档拥有自己安装的文件，不链接到快照源码目录。

现有 Tebra Google Cloud VM 的部署请遵循 [Harness 替换指南](../docs/cookbook/deploy-google-cloud.zh.md)。

## 单账号模式

当操作者与 agent（智能体）共用 GitHub 账号时，启用 **Superagent → Settings → Sources → GitHub → Single-account mode**。将该用户名加入 GitHub Policy 允许名单，然后在每次新请求或后续请求的第一个非空行写 `/superagent` 加具体指令。此模式默认关闭；带标记的 agent 输出仍被排除。
