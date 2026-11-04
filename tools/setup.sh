#!/usr/bin/env bash
# Fetch the build toolchain into .work/ (nothing is installed system-wide):
#   - Source 2 Viewer CLI 20.1 (pinned SHA-256), reads game files
#   - .NET SDK 10 (local), runs tools/LayoutPatcher
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .work

VRF_URL=https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/20.1/cli-linux-x64.zip
VRF_SHA=29d25a6d6b62377fc5386c3e5145b0a2180a401a50041afe9494b3f503deaef5

if [ ! -x .work/vrf/Source2Viewer-CLI ]; then
    echo "[setup] Source 2 Viewer CLI 20.1"
    curl -fL "$VRF_URL" -o .work/vrf-cli.zip
    echo "$VRF_SHA  .work/vrf-cli.zip" | sha256sum -c -
    rm -rf .work/vrf && mkdir -p .work/vrf
    unzip -q .work/vrf-cli.zip -d .work/vrf
    chmod +x .work/vrf/Source2Viewer-CLI
    rm .work/vrf-cli.zip
fi

if [ ! -x .work/dotnet/dotnet ]; then
    echo "[setup] .NET SDK 10 (local, .work/dotnet)"
    curl -fsSL https://dot.net/v1/dotnet-install.sh -o .work/dotnet-install.sh
    bash .work/dotnet-install.sh --channel 10.0 --install-dir .work/dotnet --no-path
fi

export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_ROOT="$PWD/.work/dotnet" NUGET_PACKAGES="$PWD/.work/nuget"
.work/dotnet/dotnet restore tools/LayoutPatcher --locked-mode
echo "[setup] ready: python3 tools/build.py"
