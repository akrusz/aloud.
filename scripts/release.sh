#!/bin/bash
# Create a release: bump version, update README links, commit, and tag.
#
# Usage:
#   scripts/release.sh           # bump patch (default)
#   scripts/release.sh patch     # 0.9.19 → 0.9.20
#   scripts/release.sh minor     # 0.9.19 → 0.10.0
#   scripts/release.sh major     # 0.9.19 → 1.0.0
#   scripts/release.sh 1.2.3     # explicit version

set -e

# Read current version from src/__init__.py
CURRENT=$(python3 -c "import re; print(re.search(r'__version__\s*=\s*\"(.+?)\"', open('src/__init__.py').read()).group(1))")
IFS='.' read -r MAJ MIN PAT <<< "$CURRENT"

ARG="${1:-patch}"

case "$ARG" in
    patch)  VERSION="$MAJ.$MIN.$((PAT + 1))" ;;
    minor)  VERSION="$MAJ.$((MIN + 1)).0" ;;
    major)  VERSION="$((MAJ + 1)).0.0" ;;
    *)
        VERSION="${ARG#v}"
        if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
            echo "Error: version must be patch, minor, major, or X.Y.Z" >&2
            exit 1
        fi
        ;;
esac

if [ "$VERSION" = "$CURRENT" ]; then
    echo "Error: version is already $CURRENT" >&2
    exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Error: uncommitted changes — commit or stash first" >&2
    exit 1
fi

echo "  $CURRENT → $VERSION"

# Bump __version__
sed -i.bak "s/__version__ = \".*\"/__version__ = \"${VERSION}\"/" src/__init__.py
rm -f src/__init__.py.bak

# Update README download links
sed -i.bak "s/Glooow-[0-9][0-9.]*-/Glooow-${VERSION}-/g" README.md
sed -i.bak "s|download/v[0-9][0-9.]*/|download/v${VERSION}/|g" README.md
rm -f README.md.bak

git add src/__init__.py README.md
git commit -m "v${VERSION}"
git tag "v${VERSION}"

echo ""
echo "  Tagged v${VERSION}"
echo "  Run: git push && git push --tags"
