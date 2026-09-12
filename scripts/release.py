#!/usr/bin/env python3
"""Cut a release: one command, three files.

    python scripts/release.py "The title" -n "What changed." -n "And this."

Bumps VERSION in sw.js to the next number, puts the entry at the top of
js/changelog.js, and sets the version line in CLAUDE.md. Then: add any new
module to SHELL in sw.js, open /tests/, commit the lot together.
"""
import argparse, datetime, io, re, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def read(p):
    s = io.open(os.path.join(ROOT, p), encoding='utf-8', newline='').read()
    return s.replace('\r\n', '\n'), '\r\n' in s

def write(p, s, crlf):
    io.open(os.path.join(ROOT, p), 'w', encoding='utf-8', newline='').write(s.replace('\n', '\r\n') if crlf else s)

def js_str(s):
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('title')
    ap.add_argument('-n', '--note', action='append', required=True, help='one line of what changed; repeat for more')
    ap.add_argument('--date', default=datetime.date.today().isoformat())
    a = ap.parse_args()
    if any(len(n.strip()) <= 12 for n in a.note):
        sys.exit('a note has to say something: more than twelve characters')

    sw, sw_crlf = read('sw.js')
    m = re.search(r"const VERSION = 'planner-v(\d+)';", sw)
    if not m:
        sys.exit('sw.js: no VERSION line')
    n = int(m.group(1)) + 1
    sw = sw.replace(m.group(0), f"const VERSION = 'planner-v{n}';")
    write('sw.js', sw, sw_crlf)

    log, log_crlf = read('js/changelog.js')
    head = 'export const CHANGELOG = [\n'
    if head not in log:
        sys.exit('js/changelog.js: no CHANGELOG')
    entry = (
        "  {\n"
        f"    version: 'v{n}', date: '{a.date}',\n"
        f"    title: {js_str(a.title)},\n"
        "    notes: [\n"
        + ",\n".join('      ' + js_str(x.strip()) for x in a.note) + "\n"
        "    ]\n"
        "  },\n"
    )
    log = log.replace(head, head + entry, 1)
    write('js/changelog.js', log, log_crlf)

    md, md_crlf = read('CLAUDE.md')
    md, k = re.subn(r"service worker \*\*planner-v\d+\*\*", f"service worker **planner-v{n}**", md)
    if k != 1:
        sys.exit('CLAUDE.md: no version line')
    write('CLAUDE.md', md, md_crlf)

    print(f"v{n}: sw.js, js/changelog.js, CLAUDE.md. New modules go in SHELL; then /tests/, then commit.")

if __name__ == '__main__':
    main()
