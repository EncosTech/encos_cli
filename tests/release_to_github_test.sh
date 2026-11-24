#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Encos
# SPDX-License-Identifier: MIT

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script_path="${repo_root}/scripts/release-to-github.sh"
wrapper_path="${repo_root}/scripts/publish-github-release.sh"
test_root=$(mktemp -d)
trap 'rm -rf "${test_root}"' EXIT

export GIT_AUTHOR_NAME="Release Test"
export GIT_AUTHOR_EMAIL="release-test@example.com"
export GIT_COMMITTER_NAME="Release Test"
export GIT_COMMITTER_EMAIL="release-test@example.com"
export GIT_ALLOW_PROTOCOL=file

leaf_repo="${test_root}/leaf"
git init -q -b main "${leaf_repo}"
printf 'recursive payload\n' >"${leaf_repo}/leaf.txt"
git -C "${leaf_repo}" add .
git -C "${leaf_repo}" commit -q -m "initial leaf"

submodule_repo="${test_root}/submodule"
git init -q -b main "${submodule_repo}"
mkdir -p "${submodule_repo}/nested"
printf 'submodule payload\n' >"${submodule_repo}/nested/payload.txt"
git -C "${submodule_repo}" -c protocol.file.allow=always submodule add -q \
  "${leaf_repo}" vendor/leaf
git -C "${submodule_repo}" add .
git -C "${submodule_repo}" commit -q -m "initial submodule"

source_repo="${test_root}/source"
git init -q -b main "${source_repo}"
mkdir -p "${source_repo}/apps/emcli" "${source_repo}/include" "${source_repo}/.gitea" "${source_repo}/openspec"
for manifest in package.json apps/emcli/package.json; do
  printf '{"version":"3.2.0-rc.1"}\n' >"${source_repo}/${manifest}"
done
printf 'public header\n' >"${source_repo}/include/public.h"
printf 'private workflow\n' >"${source_repo}/.gitea/private.yml"
printf 'internal spec\n' >"${source_repo}/openspec/change.md"
git -C "${source_repo}" -c protocol.file.allow=always submodule add -q \
  "${submodule_repo}" external/example
git -C "${source_repo}" config -f .gitmodules \
  submodule.external/example.url http://gitea.test/acme/submodule.git
for internal_root in "${source_repo}" "${source_repo}/include"; do
  printf 'agent rules\n' >"${internal_root}/AGENTS.md"
  printf 'claude rules\n' >"${internal_root}/CLAUDE.md"
  for private_dir in .claude .codex .agents .cursor .gemini .opencode; do
    mkdir -p "${internal_root}/${private_dir}"
    printf 'private configuration\n' >"${internal_root}/${private_dir}/config.txt"
  done
done
git -C "${source_repo}" add .
git -C "${source_repo}" commit -q -m "source snapshot"
initial_source_sha1=$(git -C "${source_repo}" rev-parse HEAD)

git_config="${test_root}/gitconfig"
git config -f "${git_config}" url."${submodule_repo}".insteadOf \
  https://gitea.test/acme/submodule.git

target_seed="${test_root}/target-seed"
target_bare="${test_root}/target.git"
git init -q -b main "${target_seed}"
printf 'stale\n' >"${target_seed}/stale.txt"
mkdir -p "${target_seed}/.gitea" "${target_seed}/openspec"
printf 'stale workflow\n' >"${target_seed}/.gitea/stale.yml"
printf 'stale spec\n' >"${target_seed}/openspec/stale.md"
printf 'stale agent rules\n' >"${target_seed}/AGENTS.md"
printf 'stale claude rules\n' >"${target_seed}/CLAUDE.md"
for private_dir in .claude .codex .agents .cursor .gemini .opencode; do
  mkdir -p "${target_seed}/${private_dir}"
  printf 'stale configuration\n' >"${target_seed}/${private_dir}/stale.txt"
done
git -C "${target_seed}" add .
git -C "${target_seed}" commit -q -m "seed"
git clone -q --bare "${target_seed}" "${target_bare}"

fake_bin="${test_root}/bin"
mkdir -p "${fake_bin}"
curl_log="${test_root}/curl.log"
export CURL_LOG="${curl_log}"
export TARGET_BARE="${target_bare}"
export RELEASE_FIXTURES="${test_root}/candidates"
export UPLOADS="${test_root}/uploads"
mkdir -p "${RELEASE_FIXTURES}" "${UPLOADS}"

make_candidates() {
  python3 - "${RELEASE_FIXTURES}" "$1" "${repo_root}/packages/emcli-native/manifest.json" <<'PYTHON'
import hashlib
import json
from pathlib import Path
import sys

root, commit = Path(sys.argv[1]), sys.argv[2]
driver = json.loads(Path(sys.argv[3]).read_text())['builtAgainstDriver']
version = '3.2.0-rc.1'
for target, binary, platform, arch in (
    ('linux-amd64', 'emcli-linux-x64', 'linux', 'x64'),
    ('linux-arm64', 'emcli-linux-arm64', 'linux', 'arm64'),
    ('windows-amd64', 'emcli-win32-x64.exe', 'win32', 'x64'),
):
    folder = root / target
    folder.mkdir(exist_ok=True)
    packages = [f'emcli_{version}_{target.replace("-", "_")}.{extension}'
                for extension in ('deb', 'rpm', 'tar.gz')] if platform == 'linux' else []
    files = {}
    for name in [binary, *packages]:
        content = f'tested candidate {name}\n'.encode()
        (folder / name).write_bytes(content)
        files[name] = hashlib.sha256(content).hexdigest()
    metadata = json.dumps({'sha256': files[binary], 'arch': arch, 'platform': platform}).encode()
    (folder / (binary + '.json')).write_bytes(metadata)
    files[binary + '.json'] = hashlib.sha256(metadata).hexdigest()
    manifest = json.dumps({
        'schemaVersion': 1, 'target': target, 'version': version, 'driver': driver,
        'source_commit': commit, 'source_dirty': False, 'files': files,
    }).encode()
    (folder / 'manifest.json').write_bytes(manifest)
    files['manifest.json'] = hashlib.sha256(manifest).hexdigest()
    (folder / 'SHA256SUMS').write_text(''.join(f'{digest}  {name}\n' for name, digest in sorted(files.items())))
PYTHON
}

make_candidates "${initial_source_sha1}"

cat >"${fake_bin}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

output=""
url=""
method="GET"
upload_file=""
payload=""
while (($#)); do
  case "$1" in
    --output|-o)
      output=$2
      shift 2
      ;;
    --request|-X)
      method=$2
      shift 2
      ;;
    --data-binary)
      upload_file=${2#@}
      shift 2
      ;;
    --data)
      payload=$2
      shift 2
      ;;
    --header|-H|--proto-redir)
      shift 2
      ;;
    --fail|--fail-with-body|--silent|--show-error|--location)
      shift
      ;;
    http://*|https://*)
      url=$1
      shift
      ;;
    *)
      shift
      ;;
  esac
done

printf '%s %s\n' "${method}" "${url}" >>"${CURL_LOG}"
case "${url}" in
  https://gitea.test/api/packages/packages/generic/emcli-*/3.2.0-rc.1/*)
    name=${url##*/}
    target=${url#*/generic/emcli-}
    target=${target%%/*}
    if [[ "${target}/${name}" == windows-amd64/manifest.json && "${MISSING_WINDOWS:-}" == 1 ]]; then
      exit 22
    fi
    if [[ "${name}" == *_arm64.rpm && "${TAMPER_RPM:-}" == 1 ]]; then
      printf 'corrupted package\n' >"${output}"
    else
      cp "${RELEASE_FIXTURES}/${target}/${name}" "${output}"
    fi
    ;;
  */repos/acme/mirror/releases)
    python3 - "${payload}" "$(git --git-dir="${TARGET_BARE}" rev-parse main)" <<'PYTHON'
import json
import sys

payload = json.loads(sys.argv[1])
assert payload['tag_name'] == 'v3.2.0-rc.1'
assert payload['target_commitish'] == sys.argv[2]
assert payload['draft'] is True and payload['prerelease'] is True
PYTHON
    printf '{"id":42,"upload_url":"https://uploads.github.test/repos/acme/mirror/releases/42/assets{?name,label}"}\n'
    ;;
  */repos/acme/mirror/releases/42)
    if [[ "${method}" == PATCH && "${FAIL_PATCH:-}" == 1 ]]; then
      git --git-dir="${TARGET_BARE}" update-ref refs/tags/v3.2.0-rc.1 main
      exit 22
    fi
    printf '{"id":42,"draft":false}\n'
    ;;
  *uploads.github.test*/assets*)
    name=${url##*name=}
    if [[ "${name}" == *.rpm && "${FAIL_UPLOAD:-}" == 1 ]]; then
      exit 22
    fi
    cp "${upload_file}" "${UPLOADS}/${name}"
    printf '{"state":"uploaded"}\n'
    ;;
  *)
    printf 'unexpected URL: %s\n' "${url}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${fake_bin}/curl"

run_release() {
  PATH="${fake_bin}:${PATH}" \
    GIT_CONFIG_GLOBAL="${git_config}" \
    GITEA_USERNAME="gitea-user" \
    GITEA_TOKEN="gitea-token" \
    GH_TOKEN="github-token" \
    GITHUB_SHA=ffffffffffffffffffffffffffffffffffffffff \
    bash "${script_path}" \
      --source-repo "${source_repo}" \
      --source-ref main \
      --github-repo acme/mirror \
      --github-repo-url "${target_bare}" \
      --github-branch main \
      --github-api-url https://api.github.test \
      --github-upload-url https://uploads.github.test \
      --gitea-url https://gitea.test \
      --gitea-package-owner packages \
      "$@"
}

run_release

mirror_checkout="${test_root}/mirror-checkout"
git clone -q --branch main "${target_bare}" "${mirror_checkout}"
test -f "${mirror_checkout}/include/public.h"
test -f "${mirror_checkout}/external/example/nested/payload.txt"
test -f "${mirror_checkout}/external/example/vendor/leaf/leaf.txt"
test ! -e "${mirror_checkout}/.gitmodules"
test ! -e "${mirror_checkout}/.gitea"
test ! -e "${mirror_checkout}/openspec"
test ! -e "${mirror_checkout}/stale.txt"
for internal_root in "${mirror_checkout}" "${mirror_checkout}/include"; do
  test ! -e "${internal_root}/AGENTS.md"
  test ! -e "${internal_root}/CLAUDE.md"
  for private_dir in .claude .codex .agents .cursor .gemini .opencode; do
    test ! -e "${internal_root}/${private_dir}"
  done
done
test ! -e "${mirror_checkout}/external/example/.git"
test ! -e "${mirror_checkout}/external/example/vendor/leaf/.git"
test "$(git -C "${mirror_checkout}" log -1 --format=%s)" = "release: 发布v3.2.0-rc.1"
test "$(grep -c 'uploads.github.test.*/assets' "${curl_log}")" -eq 10
for arch in amd64 arm64; do
  for format in deb rpm tar.gz; do
    cmp "${RELEASE_FIXTURES}/linux-${arch}/emcli_3.2.0-rc.1_linux_${arch}.${format}" \
      "${UPLOADS}/emcli_3.2.0-rc.1_linux_${arch}.${format}"
  done
done
cmp "${RELEASE_FIXTURES}/linux-amd64/emcli-linux-x64" "${UPLOADS}/emcli-linux-x64"
cmp "${RELEASE_FIXTURES}/linux-arm64/emcli-linux-arm64" "${UPLOADS}/emcli-linux-arm64"
cmp "${RELEASE_FIXTURES}/windows-amd64/emcli-win32-x64.exe" "${UPLOADS}/emcli-win32-x64.exe"
test "$(wc -l <"${UPLOADS}/SHA256SUMS")" -eq 9
(cd "${UPLOADS}" && sha256sum --strict --check SHA256SUMS)
grep -q 'PATCH https://api.github.test/repos/acme/mirror/releases/42' "${curl_log}"

commit_count_before=$(git --git-dir="${target_bare}" rev-list --count main)
: >"${curl_log}"
run_release
commit_count_after=$(git --git-dir="${target_bare}" rev-list --count main)
test "${commit_count_before}" = "${commit_count_after}"
test ! -s "${curl_log}"

git -C "${source_repo}" switch -q -c develop
printf 'develop snapshot\n' >"${source_repo}/develop.txt"
printf '{"version":"experimental"}\n' >"${source_repo}/package.json"
git -C "${source_repo}" add .
git -C "${source_repo}" commit -q -m "develop snapshot"
develop_sha1=$(git -C "${source_repo}" rev-parse HEAD)
git -C "${source_repo}" switch -q main

multi_branch_env="${test_root}/multi-branch.env"
cat >"${multi_branch_env}" <<EOF
GITEA_USERNAME=gitea-user
GITEA_TOKEN=gitea-token
GH_TOKEN=github-token
SOURCE_REPO=${source_repo}
MAIN_BRANCH=main
OPTIONAL_BRANCHES=develop
GITHUB_RELEASE_REPOSITORY=acme/mirror
GITHUB_RELEASE_REPOSITORY_URL=${target_bare}
GITEA_URL=https://gitea.test
GITEA_PACKAGE_OWNER=packages
GITHUB_API_URL=https://api.github.test
GITHUB_UPLOAD_URL=https://uploads.github.test
EOF

: >"${curl_log}"
PATH="${fake_bin}:${PATH}" GIT_CONFIG_GLOBAL="${git_config}" \
  bash "${wrapper_path}" --env-file "${multi_branch_env}"
test ! -s "${curl_log}"
develop_checkout="${test_root}/develop-checkout"
git clone -q --branch develop "${target_bare}" "${develop_checkout}"
test -f "${develop_checkout}/develop.txt"
test "$(git -C "${develop_checkout}" log -1 --format=%s)" = "release: 发布v3.2.0-rc.1"

printf 'changed snapshot\n' >"${source_repo}/include/public.h"
git -C "${source_repo}" add .
git -C "${source_repo}" commit -q -m "changed source snapshot"

: >"${curl_log}"
PATH="${fake_bin}:${PATH}" GIT_CONFIG_GLOBAL="${git_config}" \
  bash "${wrapper_path}" \
    --env-file "${multi_branch_env}" \
    --main-sha1 "${initial_source_sha1}"
test ! -s "${curl_log}"
main_after_pinned_wrapper=$(git --git-dir="${target_bare}" show main:include/public.h)
test "${main_after_pinned_wrapper}" = "public header"
test "$(git --git-dir="${target_bare}" show develop:develop.txt)" = "develop snapshot"

run_release \
  --source-sha1 "${initial_source_sha1}" \
  --github-branch pinned \
  --snapshot-only
pinned_checkout="${test_root}/pinned-checkout"
git clone -q --branch pinned "${target_bare}" "${pinned_checkout}"
grep -q '^public header$' "${pinned_checkout}/include/public.h"

set +e
run_release \
  --source-sha1 "${develop_sha1}" \
  --github-branch rejected \
  --snapshot-only >/dev/null 2>&1
unrelated_sha1_status=$?
set -e
test "${unrelated_sha1_status}" -ne 0
test -z "$(git --git-dir="${target_bare}" branch --list rejected)"

set +e
run_release \
  --source-sha1 ffffffffffffffffffffffffffffffffffffffff \
  --github-branch missing \
  --snapshot-only >/dev/null 2>&1
missing_sha1_status=$?
set -e
test "${missing_sha1_status}" -ne 0
test -z "$(git --git-dir="${target_bare}" branch --list missing)"

: >"${curl_log}"
if run_release >"${test_root}/wrong-commit.log" 2>&1; then
  printf 'release unexpectedly accepted candidates from another commit\n' >&2
  exit 1
fi
grep -q 'Candidate belongs to another commit' "${test_root}/wrong-commit.log"
test "$(git --git-dir="${target_bare}" rev-list --count main)" = "${commit_count_after}"
test "$(grep -c 'github.test' "${curl_log}" || true)" -eq 0
make_candidates "$(git -C "${source_repo}" rev-parse HEAD)"

: >"${curl_log}"
set +e
MISSING_WINDOWS=1 run_release
missing_status=$?
set -e
test "${missing_status}" -ne 0
test "$(git --git-dir="${target_bare}" rev-list --count main)" = "${commit_count_after}"
test "$(grep -c 'github.test' "${curl_log}" || true)" -eq 0

: >"${curl_log}"
set +e
TAMPER_RPM=1 run_release >"${test_root}/tampered.log" 2>&1
tampered_status=$?
set -e
test "${tampered_status}" -ne 0
grep -q 'Checksum mismatch: emcli_3.2.0-rc.1_linux_arm64.rpm' "${test_root}/tampered.log"
test "$(git --git-dir="${target_bare}" rev-list --count main)" = "${commit_count_after}"
test "$(grep -c 'github.test' "${curl_log}" || true)" -eq 0

: >"${curl_log}"
set +e
FAIL_UPLOAD=1 run_release
upload_status=$?
set -e
test "${upload_status}" -ne 0
test "$(git --git-dir="${target_bare}" rev-list --count main)" = "${commit_count_after}"
grep -q 'DELETE https://api.github.test/repos/acme/mirror/releases/42' "${curl_log}"

: >"${curl_log}"
set +e
FAIL_PATCH=1 run_release
patch_status=$?
set -e
test "${patch_status}" -ne 0
test "$(git --git-dir="${target_bare}" rev-list --count main)" = "${commit_count_after}"
test -z "$(git --git-dir="${target_bare}" tag --list v3.2.0-rc.1)"
grep -q 'DELETE https://api.github.test/repos/acme/mirror/releases/42' "${curl_log}"

unsafe_urls=(
  'http://example.test/acme/unsafe.git'
  'https://token@gitea.test/acme/unsafe.git'
  'https://example.test/acme/unsafe.git'
)
for unsafe_url in "${unsafe_urls[@]}"; do
  git -C "${source_repo}" config -f .gitmodules \
    submodule.external/example.url "${unsafe_url}"
  git -C "${source_repo}" add .gitmodules
  git -C "${source_repo}" commit -q -m "unsafe submodule fixture"
  set +e
  run_release >/dev/null 2>&1
  unsafe_status=$?
  set -e
  test "${unsafe_status}" -ne 0
  test "$(git --git-dir="${target_bare}" rev-list --count main)" = "${commit_count_after}"
done

printf 'release_to_github_test: PASS\n'
