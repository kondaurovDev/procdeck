#!/bin/sh
# Installs the procdeck binary from a GitHub release:
#
#   curl -fsSL https://raw.githubusercontent.com/kondaurovDev/procdeck/main/install.sh | sh
#
#   PROCDECK_VERSION=2.0.0  picks a version (default: the latest release)
#   PROCDECK_INSTALL=/dir   where the binary goes (default: ~/.local/bin)
#
# Downloads the tarball for this machine, checks it against the release's
# checksums.txt, and puts `procdeck` in place. Nothing else is written.
set -eu

repo="kondaurovDev/procdeck"
install_dir="${PROCDECK_INSTALL:-$HOME/.local/bin}"

fail() {
  echo "procdeck: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

need curl
need tar

os=$(uname -s)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*)
    fail "no native Windows build — install inside WSL instead"
    ;;
  *) fail "unsupported OS: $os" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported architecture: $arch" ;;
esac

# A version to install: given, else the latest release's tag (vX.Y.Z → X.Y.Z).
# Only `v` tags carry binaries; the 1.x releases are tagged procdeck@X.Y.Z.
version="${PROCDECK_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" |
    sed -n 's/.*"tag_name": *"v\([0-9][^"]*\)".*/\1/p' | head -n 1)
  [ -n "$version" ] || fail "the latest release has no binaries — set PROCDECK_VERSION"
fi
version="${version#v}"

archive="procdeck_${version}_${os}_${arch}.tar.gz"
base="https://github.com/$repo/releases/download/v$version"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "procdeck: downloading v$version for $os/$arch"
curl -fsSL -o "$tmp/$archive" "$base/$archive" ||
  fail "no release for $os/$arch at $base/$archive"
curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt" ||
  fail "could not download checksums.txt"

# sha256sum on Linux, shasum on macOS.
expected=$(grep " $archive\$" "$tmp/checksums.txt" | cut -d ' ' -f 1)
[ -n "$expected" ] || fail "$archive is not in checksums.txt"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$archive" | cut -d ' ' -f 1)
else
  need shasum
  actual=$(shasum -a 256 "$tmp/$archive" | cut -d ' ' -f 1)
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $archive"

tar -xzf "$tmp/$archive" -C "$tmp" procdeck
mkdir -p "$install_dir"
# Replace by rename, so a running `procdeck` keeps its old inode.
mv -f "$tmp/procdeck" "$install_dir/procdeck"
chmod 0755 "$install_dir/procdeck"

echo "procdeck: installed v$version to $install_dir/procdeck"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    echo "procdeck: $install_dir is not in your PATH — add it, for example:"
    echo "  export PATH=\"$install_dir:\$PATH\""
    ;;
esac
