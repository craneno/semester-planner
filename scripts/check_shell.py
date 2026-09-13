#!/usr/bin/env python3
"""A shell file changed, so VERSION has to have.

    python scripts/check_shell.py [base]     base: a commit, HEAD~1 by default

Compares HEAD to its parent: if any file the service worker caches (its
SHELL, or sw.js itself) changed and VERSION did not, a browser would keep
the old files, so the build stops here. Run by the Deploy job on each push,
and by .githooks/pre-push before one (git config core.hooksPath .githooks).
"""
import re, subprocess, sys

def git(*args):
    r = subprocess.run(['git', *args], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None

def version(text):
    m = re.search(r"const VERSION = '([^']+)'", text or '')
    return m.group(1) if m else None

def shell(text):
    i = text.index('const SHELL')
    body = text[i:text.index('];', i)]
    return {p for p in re.findall(r"'\./([^']*)'", body)}

def main():
    base = sys.argv[1] if len(sys.argv) > 1 else 'HEAD~1'
    old = git('show', f'{base}:sw.js')
    if old is None:
        print(f'no {base} to compare with; nothing checked')
        return 0
    new = open('sw.js', encoding='utf-8').read()
    changed = (git('diff', '--name-only', base, 'HEAD') or '').split()
    cached = shell(new) | {'sw.js', 'index.html'}
    hit = sorted(f for f in changed if f in cached)
    if not hit:
        print('no shell file changed')
        return 0
    if version(old) == version(new):
        print(f'shell files changed but VERSION is still {version(new)}: bump it in sw.js and add the release to js/changelog.js')
        print('  ' + '\n  '.join(hit))
        return 1
    print(f'{version(old)} -> {version(new)}, for: ' + ', '.join(hit))
    return 0

if __name__ == '__main__':
    sys.exit(main())
