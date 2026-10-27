#!/usr/bin/env bash
# Create the GitHub repo (if needed) and push this checkout.
#
#   GH_TOKEN=github_pat_xxx bash scripts/publish-github.sh <github-username>
#
# The token is a fine-grained PAT with "Contents: read and write" and
# "Administration: read and write" on the target account; it is used for the
# API call and the push, and is never written to .git/config or to disk.
set -euo pipefail

USER="${1:-${GITHUB_USER:-}}"
REPO="${REPO:-dsh-fnos-upgrader}"
if [ -z "${GH_TOKEN:-}" ]; then
  echo "缺少 GH_TOKEN。用法: GH_TOKEN=github_pat_... bash scripts/publish-github.sh <用户名>" >&2
  exit 1
fi
if [ -z "$USER" ]; then
  echo "用法: GH_TOKEN=... bash scripts/publish-github.sh <github-username>" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Keep the manifest truthful about where this lives.
node -e '
const fs = require("node:fs")
const file = "package.json"
const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
const url = `https://github.com/${process.env.GH_USER}/${process.env.GH_REPO}`
pkg.repository = { type: "git", url: `git+${url}.git` }
pkg.homepage = url
pkg.bugs = { url: `${url}/issues` }
fs.writeFileSync(file, JSON.stringify(pkg, null, 1) + "\n")
' GH_USER="$USER" GH_REPO="$REPO"

git init -b main >/dev/null 2>&1 || true
git add -A
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  git -c user.name="$USER" -c user.email="$USER@users.noreply.github.com" \
    commit -q -m "dsh-fnos-upgrader: fnOS-adapted DeepSeek Harness updater

Fork of dsh-update-copilot (MIT) with fnOS-specific changes:
- core updates pinned to the newest version the profile plugins accept
- one-click restart through the fnOS gateway control endpoint
- plugin preflight evaluated against the running host, not the newest release
- patch-name audit and host-package resolution fixed for shim/npm-global installs
- attachment durability patch for /vol* mode-000 mounts"
else
  git -c user.name="$USER" -c user.email="$USER@users.noreply.github.com" \
    commit -q -m "Update dsh-fnos-upgrader" || true
fi

status="$(curl -s -o /tmp/dsh-fnos-upgrader-create.json -w '%{http_code}' \
  -X POST https://api.github.com/user/repos \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d "{\"name\":\"$REPO\",\"description\":\"fnOS-adapted update copilot for DeepSeek Harness\",\"private\":false}")"
case "$status" in
  201) echo "已创建 $USER/$REPO" ;;
  422) echo "仓库已存在，直接推送" ;;
  *)   echo "创建仓库失败 HTTP $status" >&2; cat /tmp/dsh-fnos-upgrader-create.json >&2; exit 1 ;;
esac

git remote remove origin >/dev/null 2>&1 || true
git remote add origin "https://github.com/$USER/$REPO.git"
git push -q "https://x-access-token:$GH_TOKEN@github.com/$USER/$REPO.git" main:main
git branch --set-upstream-to=origin/main main >/dev/null 2>&1 || true

echo "完成: https://github.com/$USER/$REPO"
