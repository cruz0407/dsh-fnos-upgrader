# dsh-fnos-upgrader

飞牛（fnOS）版的 DeepSeek Harness 升级助手。基于 [dsh-update-copilot](https://github.com/hezhongtang/dsh-update-copilot)（MIT）改造，保留它的全量雷达与带闸门更新，补上飞牛缺的两件事：

1. **只升级到「插件能接受」的核心版本**。飞牛这套 profile 里插件 peer 是精确锁版本的（例如 `@tnnevol/dsh-*` 锁 `0.2.1-rc.3`），原版会挑 npm 最新核心（如 `0.2.1-rc.4`），装上去 profile 直接起不来。这里的「更新本体」会先算：所有已装插件的最新版都能接受的最高核心版本，只有它才会被安装；没有可升级的兼容版本时明确说明原因。
2. **走飞牛网关一键重启**。飞牛的 dsh 不在 systemd/pm2 下，原版「升级后请手动重启」在这里没有出口。本插件通过 `app.sock` 调网关自己的 `__fnos-gateway/control/web/restart`，升级完点一下即可重启并在页面自动恢复。

## 面板入口

插件页里的**更新助手**：核心卡片 + 插件列表 + 一键更新 + 重启横幅（`RestartBanner`，仅在检测到飞牛网关时出现按钮）。

## 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/fnos-upgrader/plan?profile=web` | 兼容升级计划：核心当前/最新/可升级目标、插件清单、是否飞牛托管 |
| GET | `/fnos-upgrader/restart-status` | `{"available":true,"prefix":"/app/fn-deepseek-harness"}` |
| POST | `/fnos-upgrader/restart` | `{"confirm":true}`，回包后 0.8s 调网关重启 |
| POST | `/fnos-upgrader/update-core` | 不传 `target` 时自动钉到兼容版本；不兼容时返回 `core_no_compatible_target` |

所有 POST 都要同源（Origin 的 host 必须等于 Host 头）。飞牛在网关层终止 TLS，所以这里放宽了协议比较——跨站页面伪造不了 Host，这仍是 CSRF 的主防线。重启接口额外要求请求来自回环地址。

## 安装 / 更新

```sh
# 从本仓库安装（dsh 支持 github: 规格）
dsh plugin --profile web add github:<你的用户名>/dsh-fnos-upgrader

# 或者先拷到 DSH_HOME 下的稳定位置再装
mkdir -p "$DSH_HOME/plugins"
cp -a dsh-fnos-upgrader "$DSH_HOME/plugins/"
dsh plugin --profile web add "$DSH_HOME/plugins/dsh-fnos-upgrader"
```

装完重启生效（下面这条就是插件自己用的那个网关接口）：

```sh
curl --unix-socket "$(dirname "${DSH_CWD:-/vol2/@appcenter/fn-deepseek-harness}")/app.sock" \
  -X POST -H 'x-requested-with: fetch' -H 'x-trim-isadmin: true' \
  "http://localhost/app/fn-deepseek-harness/__fnos-gateway/control/web/restart"
```


## 附带的核心补丁（图片附件）

飞牛把 `/vol1`、`/vol2` 挂成 `d---------` + trimacl ACL：能读写自己的子目录，但连 `open()` 挂载根都不行。DSH 的 `dsh-attachment-local` 存附件时会逐级对祖先目录做 fsync，走到 `/vol2` 就 `EACCES`，浏览器侧只看到 `prompt rejected (session/agent-busy)`——文字消息正常，图片永远发不出去。

`lib/fnos-patch.js` 把这一步改成「祖先打不开就跳过」（fsync 只是崩溃持久性加固，不是正确性）。补丁带标记、幂等，插件启动时检查一次，**每次核心升级后自动重打**，因为核心安装会整个替换这个包。


## 从源码更新 / 发布

本仓库同时是插件源码。飞牛自带的 PATH 里的 git 缺少 HTTPS 传输助手（`git-remote-https`），联网的 git 操作要么用 `/usr/bin/git`，要么显式指定：

```sh
GIT_EXEC_PATH=/usr/lib/git-core git push
```

首次建仓并推送：`GH_TOKEN=github_pat_... bash scripts/publish-github.sh <github-username>`（脚本会自动挑一个能联网的 git）。

插件启动时如果发现 `$DSH_HOME/tools/bin/git`，会把它放到 PATH 最前面——这样面板里对 `github:` 规格插件的更新也能正常解析，不需要改宿主启动参数。


## 指定本体版本

核心卡片里多了一个版本下拉：列出已发布的各版本，并按**当前已装插件**的真实 peer 声明标注兼容性。

| 标记 | 含义 |
|---|---|
| ✓ | 现有插件都接受，装上能启动 |
| ⚠ | 现在不行，但把这些插件更新到最新版后可以 |
| ✖ | 任何插件版本都不接受（或还没发布适配） |

选中「✖」的版本仍可点安装，但会走二次确认并以 `force` 越过闸门——那是给「我知道自己在做什么」的人用的，面板会先把拒绝它的插件列出来。降级同样需要二次确认。

`GET /fnos-upgrader/core-versions?profile=web` 返回同样的数据，便于脚本调用。

## 已知边界

- 只升级**核心**与**插件**；若某插件最新版不认任何新核心，会停在当前核心并提示，不会硬升。
- 兼容判定按 `peerDependencies` 里的 `@deepseek-ai/dsh-*` 区间做 semver 匹配（`^ ~ >= <= > < = ||`），与 DSH 启动时的策略一致。
- 插件更新后若宿主起不来，可用 `dsh --profile web --dump-config` 定位，或在 profile 的 `cordis.patch.yml` 给对应行加 `disabled: true`。
- 个人向 fork，不随上游发布。

## 许可

MIT，保留上游版权声明（见 LICENSE）。
