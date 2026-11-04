#!/usr/bin/env python3
"""Bundle the Panorama script: storage module + main script in one IIFE.

The game loads exactly one script file. BUILD_ID is derived from the bundled
sources and the bridge URL, so identical inputs give an identical script.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = '1.0.0'
SOURCES = [ROOT / 'src/panorama/roster_tools_storage.js', ROOT / 'src/panorama/roster_tools.js']
BRIDGE_CONFIG = ROOT / 'data/bridge.json'


def bridge_url() -> str:
    url = json.loads(BRIDGE_CONFIG.read_text())['url']
    if url and not url.startswith('https://'):
        raise ValueError('The bridge URL must be https:// (CitadelHTMLPanel loads nothing else)')
    return url


def bundle(url: str | None = None) -> str:
    url = bridge_url() if url is None else url
    texts = [path.read_text(encoding='utf-8').rstrip() for path in SOURCES]
    digest = hashlib.sha256('\0'.join([VERSION, url] + texts).encode()).hexdigest()
    build_id = f'{VERSION}+{digest[:8]}'
    return (
        f'// Roster Tools {VERSION} (build {build_id}). MIT License. UI-only Deadlock mod.\n'
        '(function () {\n'
        "'use strict';\n"
        f'var VERSION = "{VERSION}";\n'
        f'var BUILD_ID = "{build_id}";\n'
        f'var BRIDGE_URL = {json.dumps(url)};\n'
        + '\n'.join(texts) + '\n'
        '}());\n'
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bridge-url', help='override data/bridge.json ("" disables storage)')
    parser.add_argument('-o', '--output', type=Path)
    args = parser.parse_args()
    text = bundle(args.bridge_url)
    if args.output:
        args.output.write_text(text, encoding='utf-8')
    else:
        sys.stdout.write(text)


if __name__ == '__main__':
    main()
