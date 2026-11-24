# CI artifacts and package publication

The Gitea workflow is `.gitea/workflows/build.yml`. It builds the checked-out source on native Linux amd64, Linux arm64 and Windows amd64 runners. Each target runs the single-executable FakeAdapter/JSON/API and TUI tests before its candidate is uploaded.

## Outputs

| Artifact name prefix | Contents |
| --- | --- |
| `emcli-linux-amd64-<commit>` | `emcli-linux-x64`, build metadata, `.deb`, `.rpm`, `.tar.gz`, manifest and checksums |
| `emcli-linux-arm64-<commit>` | `emcli-linux-arm64`, build metadata, `.deb`, `.rpm`, `.tar.gz`, manifest and checksums |
| `emcli-windows-amd64-<commit>` | `emcli-win32-x64.exe`, build metadata, manifest and checksums |

The executable includes Node and its native driver closure; no separate Node, pnpm or driver SDK installation is required on the destination. Linux still requires glibc 2.28+, libstdc++ and libgcc. USB/serial permissions and physical-device prerequisites are unchanged. Windows uses the existing MinGW x64 runner and supports the UTF-8 active-code-page manifest (Windows 10 1903+).

Linux packages install a launcher at `/usr/bin/emcli`, a self-contained Node/application/driver runtime at `/usr/lib/emcli`, and the existing CDC udev rules. The runtime comes from the same verified asset manifest as the SEA; packaging checks its archive hash and does not rebuild it. DEB/RPM depend on libcap tools and authorize only the driver helpers during installation and upgrades. CI verifies helper capabilities, reinstalls to check restoration, and exercises the installed runtime with an empty PATH. Portable SEA executables remain separate artifacts. CPack stripping is disabled for RPM to preserve the tested native files. Debian and RPM prerelease versions use `~`, e.g. `2.0.0~alpha.0`, to sort before `2.0.0`. File names keep the original npm version.

Direct binary artifacts may lose Unix execute permissions during download: run `chmod +x emcli-linux-*`. The tar archive preserves permissions. `SHA256SUMS` covers the payload and release manifest.

## Build environment

Normal builds consume a versioned, pre-provisioned environment. `scripts/ci/prepare.py` only validates its platform, versions, checksums and exact `pnpm-lock.yaml` digest; missing or stale environments fail immediately instead of downloading replacements. `pnpm install --offline --frozen-lockfile` consumes the image's dependency store, with Corepack networking disabled. Package tests require libcap tools already installed and never run apt/dnf. Windows never runs pip during ordinary builds.

Linux uses `git.in.encos.cn/container/ubuntu:emcli-ci-glibc2.28-20261123-v2-{amd64,arm64}`. Each image extends the existing glibc 2.28 compiler image with `/opt/emcli-ci/20261123-v2`, which contains SHA-256-pinned Node 24.22.1 and matching headers, driver SDK 4.3.1, pnpm 12.15.0 and the platform-specific locked dependency store and pnpm supply-chain metadata cache. Windows uses `%USERPROFILE%/work/tools/emcli-ci/20261123-v2`, with matching Node and SDK headers, pnpm store and pywinpty 3.1.2. Windows retains the existing `ci-env.cmd`, Python and MinGW installation. The build generates import libraries from the locked Windows driver DLLs in a workspace copy of the SDK.

Dependency downloads are confined to the manual `.gitea/workflows/provision-ci.yml` workflow. It prepares Linux bundles on native amd64/arm64 runners and updates the Windows host environment. Linux artifacts contain `toolchain.tar.gz`; assemble and push each base image with:

```sh
bash scripts/ci/images/assemble.sh amd64 /path/to/amd64/toolchain.tar.gz
bash scripts/ci/images/assemble.sh arm64 /path/to/arm64/toolchain.tar.gz
```

The Dockerfile uses only ADD, so assembling an arm64 image does not require local CPU emulation. Run provisioning only from trusted branches. When changing dependencies or pinned tool versions, prepare a new environment revision and publish both architecture images before updating ordinary builds to use them. Increment the revision in provisioning paths, Dockerfile, assembly script, validation and build scripts/workflow together. The exact lock digest deliberately prevents reuse of an obsolete dependency store. Registry credentials are used only during provisioning and are not stored in the bundles or images.

Package install tests cover Ubuntu 22.04/24.04 and AlmaLinux 8/9 on both architectures, with additional tar extraction tests. Source checkout, base-image pulls, artifact transport and publishing still require network access; application dependency installation does not. `USER_PASSWORD` is the existing Gitea secret for private image pulls, provisioning, current-run artifact downloads and package uploads, and is not passed into ordinary build steps.

## Publication policy

- Pull requests and pushes to `feat/node-emcli-rewrite` produce artifacts without publishing.
- A successful push to `main` publishes only if the workspace version changed from the push's `before` commit. The first transition from the old CMake-based CLI compares against its CMake version.
- Manual runs default to build/test only. Set the `publish` input to true on `main` to publish the current version explicitly.
- Publishing waits for all three builds and every package installation test. It downloads candidates from this workflow run, validates complete file sets, checksums, matching versions/commits and clean source provenance **before any upload**. It never rebuilds the executable.
- Failed checks prevent publication. Upload failures fail the workflow; existing versions are not deleted or silently replaced. The package server has no multi-repository transaction, so a network failure partway through uploading can leave a partial release that requires inspection before retrying.

The package owner remains `packages` at `https://git.in.encos.cn`:

| Output | Existing repository endpoint |
| --- | --- |
| Debian (both architectures) | `debian/pool/jammy/main/upload`, `debian/pool/noble/main/upload` |
| RPM (both architectures) | `rpm/portable/upload` |
| Complete candidates for all targets | `generic/emcli-<linux-amd64\|linux-arm64\|windows-amd64>/<version>/<filename>` |

Publication uses `USER_PASSWORD`, with `GITEA_PACKAGE_USER=bismarckkk`. Fork PRs cannot run on the shared trusted runners.

## GitHub releases

After Gitea has published all three candidates, dispatch `publish-github-release` from `main`. The workflow checks the triggering user against `RELEASE_ALLOWED_ACTORS`. Configure the repository variables `GITEA_USERNAME`, `GITHUB_RELEASE_REPOSITORY`, and `GITHUB_RELEASE_REPOSITORY_URL`, and the secrets `GITEA_TOKEN` and `GH_TOKEN`. `GITEA_PACKAGE_OWNER` defaults to `packages`. For a local run, use `scripts/.env.example` to configure `scripts/.env`, then invoke `bash scripts/publish-github-release.sh`.

The publisher reads the workspace version from the selected source commit. By default it uses the tip of `MAIN_BRANCH` (`main`). If the branch has advanced since Gitea published the candidates, set the `main_sha1` workflow input or use `--main-sha1` locally with the candidate's full `source_commit`.

The workflow downloads each target's versioned candidate, validates the manifests, source commits, and file checksums, and then pushes the GitHub snapshot. The Release includes six Linux packages (`.deb`, `.rpm`, and `.tar.gz` for amd64 and arm64), the portable executables `emcli-linux-x64`, `emcli-linux-arm64`, and `emcli-win32-x64.exe`, and a combined `SHA256SUMS`. Prerelease versions are marked as prereleases. The Release stays in draft until all assets are uploaded. A failed upload or final publication triggers rollback of the draft, snapshot branch, and any tag created for the failed release. `OPTIONAL_BRANCHES` publishes the corresponding source snapshots after the main release succeeds.

## Local verification

```sh
python3 scripts/ci/test-release.py
python3 scripts/ci/test-toolchain.py
bash tests/publish_github_release_wrapper_test.sh
bash tests/release_to_github_test.sh
# Inside the glibc 2.28 build image:
bash scripts/ci/build-linux.sh
# In a disposable matching-architecture distribution container:
python3 scripts/ci/test-package.py dist/artifacts/linux-amd64 deb
# Validate a combined download of all three candidates without uploading:
python3 scripts/ci/publish.py build/candidate --require-clean
```

A clean Linux checkout can verify dependency independence by running the entire build with networking disabled:

```sh
docker run --rm --network none -v "$PWD:/workspace" -w /workspace \
  git.in.encos.cn/container/ubuntu:emcli-ci-glibc2.28-20261123-v2-amd64 \
  bash scripts/ci/build-linux.sh
```

On the Windows CI host, run `scripts/ci/build-windows.ps1` from a clean checkout. Packaging requires a Git checkout for provenance; it intentionally rejects incomplete SEA metadata. Local dirty builds can generate artifacts for testing, but cannot pass the clean-source publication gate.

The `20261123-v2` environments include the pinned driver 4.3.1 SDK and matching dependency lock. The native package manifest records the SDK version used for CI builds.
