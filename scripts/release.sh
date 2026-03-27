#!/bin/bash
# Create a release: bump version, update README links, commit, tag, push,
# and create the GitHub release (which triggers the build workflow).
#
# Usage:
#   scripts/release.sh           # bump patch (default)
#   scripts/release.sh patch     # 0.9.19 → 0.9.20
#   scripts/release.sh minor     # 0.9.19 → 0.10.0
#   scripts/release.sh major     # 0.9.19 → 1.0.0
#   scripts/release.sh same      # re-release current version
#   scripts/release.sh 1.2.3     # explicit version

set -e

# Read current version from src/__init__.py
CURRENT=$(python3 -c "import re; print(re.search(r'__version__\s*=\s*\"(.+?)\"', open('src/__init__.py').read()).group(1))")
IFS='.' read -r MAJ MIN PAT <<< "$CURRENT"

ARG="${1:-patch}"

case "$ARG" in
    same)   VERSION="$CURRENT" ;;
    patch)  VERSION="$MAJ.$MIN.$((PAT + 1))" ;;
    minor)  VERSION="$MAJ.$((MIN + 1)).0" ;;
    major)  VERSION="$((MAJ + 1)).0.0" ;;
    *)
        VERSION="${ARG#v}"
        if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
            echo "Error: version must be same, patch, minor, major, or X.Y.Z" >&2
            exit 1
        fi
        if [ "$VERSION" = "$CURRENT" ]; then
            echo "Error: version is already $CURRENT (use 'same' to re-release)" >&2
            exit 1
        fi
        ;;
esac

if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Error: uncommitted changes — commit or stash first" >&2
    exit 1
fi

BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
    echo "  Warning: releasing from '$BRANCH', not main"
fi

echo ""
echo "  $CURRENT → $VERSION  (on $BRANCH)"
echo ""
printf "  Proceed? [Y/n] "
read -r REPLY
if [ "$REPLY" = "n" ] || [ "$REPLY" = "N" ]; then
    echo "  Aborted."
    exit 0
fi

# Bump __version__
sed -i.bak "s/__version__ = \".*\"/__version__ = \"${VERSION}\"/" src/__init__.py
rm -f src/__init__.py.bak

# Update README download links
sed -i.bak "s/Glooow-[0-9][0-9.]*-/Glooow-${VERSION}-/g" README.md
sed -i.bak "s|download/v[0-9][0-9.]*/|download/v${VERSION}/|g" README.md
rm -f README.md.bak

git add src/__init__.py README.md
git diff --cached --quiet || git commit -m "v${VERSION}"

# Re-release: move existing tag to this commit
if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
    git tag -d "v${VERSION}"
    git push origin ":refs/tags/v${VERSION}" 2>/dev/null || true
fi
git tag "v${VERSION}"

echo ""
echo "  Pushing..."

git push
if [ "$ARG" = "same" ]; then
    git push origin "v${VERSION}" --force
else
    git push origin "v${VERSION}"
fi

# Create GitHub release (triggers build workflow)
if command -v gh >/dev/null 2>&1; then
    echo "  Creating GitHub release..."
    if [ "$ARG" = "same" ]; then
        # Delete existing release first for re-release
        gh release delete "v${VERSION}" --yes 2>/dev/null || true
    fi
    gh release create "v${VERSION}" --title "v${VERSION}"
    echo ""
    echo "  Released v${VERSION} — build started ✓"
else
    echo ""
    echo "  Pushed v${VERSION} ✓"
    echo "  Create the release at: https://github.com/akrusz/glooow/releases/new?tag=v${VERSION}"
fi
