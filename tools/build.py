#!/usr/bin/env python3
"""Build the Roster Tools VPK and release ZIP from the installed game.

Reads (never modifies) the game: the stock roster layout is taken from the
current pak01_dir.vpk, one script include is added, and the result is packed,
read back and diffed against stock before anything lands in dist/.
"""
import argparse
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bundle import VERSION, bundle  # noqa: E402
from vpk import pack, read_index  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.work'
LAYOUT = 'panorama/layout/popups/citadel_popup_roster_select.vxml_c'
SCRIPT = 'panorama/scripts/roster_tools.vjs_c'
APP_ID = '1422450'
ZIP_TIME = (2026, 1, 1, 0, 0, 0)


def log(message: str) -> None:
    print(f'[build] {message}', flush=True)


def steam_libraries() -> list[Path]:
    roots = [Path.home() / '.steam/steam', Path.home() / '.local/share/Steam',
             Path.home() / '.var/app/com.valvesoftware.Steam/.local/share/Steam']
    libraries: list[Path] = []
    for root in roots:
        vdf = root / 'steamapps/libraryfolders.vdf'
        if not vdf.is_file():
            continue
        for match in re.finditer(r'"path"\s+"([^"]+)"', vdf.read_text(errors='replace')):
            path = Path(match[1]).resolve()
            if path not in libraries:
                libraries.append(path)
    return libraries


def find_game(explicit: Path | None) -> Path:
    candidates = [explicit] if explicit else []
    if os.environ.get('DEADLOCK_ROOT'):
        candidates.append(Path(os.environ['DEADLOCK_ROOT']))
    candidates += [lib / 'steamapps/common/Deadlock' for lib in steam_libraries()]
    for candidate in candidates:
        if candidate and (candidate / 'game/citadel/pak01_dir.vpk').is_file():
            return candidate.resolve()
    raise SystemExit('Deadlock not found. Pass --game /path/to/steamapps/common/Deadlock or set DEADLOCK_ROOT.')


def game_build(game: Path) -> str:
    manifest = game.parents[1] / f'appmanifest_{APP_ID}.acf'
    match = re.search(r'"buildid"\s+"(\d+)"', manifest.read_text()) if manifest.is_file() else None
    return match[1] if match else 'unknown'


def run(cmd: list, **kwargs) -> subprocess.CompletedProcess:
    result = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        raise SystemExit(f'Command failed ({result.returncode}): {" ".join(map(str, cmd))}\n{result.stdout}\n{result.stderr}')
    return result


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def decompile_layout(vrf: Path, compiled: Path, out_file: Path) -> str:
    """XML text of a compiled layout, without the version comment VRF adds."""
    run([vrf, '-i', compiled, '-d', '-o', out_file])  # single input: -o is the output file
    if not out_file.is_file():
        raise SystemExit(f'Decompiling {compiled} produced no {out_file}')
    return re.sub(r'^<!--.*?-->\s*', '', out_file.read_text(encoding='utf-8'))


def check_layout_diff(stock_xml: str, patched_xml: str) -> None:
    """The patched layout must equal stock plus exactly one <scripts> include."""
    diff = [line for line in difflib.ndiff(stock_xml.splitlines(), patched_xml.splitlines())
            if line[:2] in ('- ', '+ ')]
    expected = ['+ \t<scripts>', f'+ \t\t<include src="s2r://{SCRIPT}" />', '+ \t</scripts>']
    if diff != expected:
        raise SystemExit('Patched layout differs from stock in more than the script include:\n' + '\n'.join(diff))


def write_zip(path: Path, entries: list[tuple[str, bytes]]) -> None:
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)


def release_readme(build: str, fingerprint_status: str) -> str:
    return f"""Roster Tools {VERSION} - UI-only Deadlock mod
Built from the roster layout of Steam build {build} ({fingerprint_status}).

Adds a small panel next to the hero grid in the roster screen:
Clear roster, Undo, Clear priorities, Select all, Invert, saved presets
and a live counter with roster hints.
Presets are stored on your PC in the game's embedded browser storage, through
a small static page (https://piotrpanawas.github.io/deadlock-roster-tools-bridge/);
no data leaves your computer.
Every change is a replayed card click started by your button press.
The mod never presses Play, never avoids a hero, never moves the priority token.

INSTALL (Deadlock Mod Manager): close the game, Mods Library > Add Local Mod,
pick this ZIP, enable it, start the game.
INSTALL (manual): copy pak57_dir.vpk to game/citadel/addons/ (any free pakNN
number) with citadel/addons in gameinfo.gi SearchPaths.

CONFLICTS: any mod replacing panorama/layout/popups/citadel_popup_roster_select.vxml_c
(Hero Select Plus, Release Order Roster, New roster hero select screen).
AFTER A GAME UPDATE: disable the mod until a build for the new layout is available.
Valve does not approve or guarantee UI mods; use at your own risk.
Valve's UI resources remain Valve's property; the MIT license covers this mod's code.
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, help='Deadlock folder (contains game/)')
    parser.add_argument('--vrf', type=Path, default=WORK / 'vrf/Source2Viewer-CLI')
    parser.add_argument('--dotnet', type=Path, default=WORK / 'dotnet/dotnet')
    parser.add_argument('--bridge-url', help='override data/bridge.json ("" = session-only presets)')
    parser.add_argument('--pak', type=int, default=57, help='pak number used for the VPK name (01-99)')
    parser.add_argument('--check-only', action='store_true', help='only compare the stock layout fingerprint')
    args = parser.parse_args()
    if not 1 <= args.pak <= 99:
        parser.error('--pak must be 1-99')
    for tool in (args.vrf, args.dotnet):
        if not tool.is_file():
            raise SystemExit(f'Missing {tool}. Run tools/setup.sh first.')

    game = find_game(args.game)
    build = game_build(game)
    pak01 = game / 'game/citadel/pak01_dir.vpk'
    log(f'game: {game} (Steam build {build})')
    compat_path = ROOT / 'data/compat.json'
    compat = json.loads(compat_path.read_text())

    WORK.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=WORK, prefix='build-') as tmp:
        staging = Path(tmp)
        # With a filter matching exactly one file, VRF treats -o as the output file.
        native = staging / 'native.vxml_c'
        run([args.vrf, '-i', pak01, '-f', LAYOUT, '-o', native])
        if not native.is_file():
            raise SystemExit(f'Could not extract {LAYOUT} from {pak01}')
        fingerprint = sha256(native.read_bytes())
        known = [entry for entry in compat['known_layouts'] if entry['native_layout_sha256'] == fingerprint]
        fingerprint_status = ('layout fingerprint known from build ' + ', '.join(e['game_build'] for e in known)
                              if known else 'NEW layout fingerprint, not yet verified in game')
        log(f'stock layout sha256 {fingerprint[:16]}...: {fingerprint_status}')
        if args.check_only:
            sys.exit(0 if known else 1)

        script_text = bundle(args.bridge_url)
        build_id = re.search(r'var BUILD_ID = "([^"]+)"', script_text)[1]
        script_js = staging / 'roster_tools.js'
        script_js.write_text(script_text, encoding='utf-8')
        if shutil.which('node'):
            run(['node', '--check', script_js])
        else:
            log('node not found: skipping JavaScript syntax check')

        env = dict(os.environ, DOTNET_CLI_TELEMETRY_OPTOUT='1', DOTNET_NOLOGO='1',
                   DOTNET_ROOT=str(args.dotnet.parent), NUGET_PACKAGES=str(WORK / 'nuget'))
        project = ROOT / 'tools/LayoutPatcher'
        run([args.dotnet, 'restore', project, '--locked-mode'], env=env)
        run([args.dotnet, 'build', project, '-c', 'Release', '--no-restore', '-o', WORK / 'patcher'], env=env)
        output = staging / 'mod'
        audit_path = staging / 'audit.json'
        patcher = run([args.dotnet, WORK / 'patcher/LayoutPatcher.dll', native, script_js, output, LAYOUT, SCRIPT, audit_path], env=env)
        log(patcher.stdout.strip())

        files = {p.relative_to(output).as_posix(): p.read_bytes() for p in output.rglob('*') if p.is_file()}
        if set(files) != {LAYOUT, SCRIPT}:
            raise SystemExit(f'Unexpected payload: {sorted(files)}')
        vpk_name = f'pak{args.pak:02d}_dir.vpk'
        vpk_path = staging / vpk_name
        pack(files, vpk_path)

        # Independent readback with Source 2 Viewer: same bytes, same index.
        if sorted(read_index(vpk_path)) != sorted(files):
            raise SystemExit('VPK index readback mismatch')
        run([args.vrf, '-i', vpk_path, '-o', staging / 'readback'])
        readback = {p.relative_to(staging / 'readback').as_posix(): p.read_bytes()
                    for p in (staging / 'readback').rglob('*') if p.is_file()}
        if readback != files:
            raise SystemExit('Source 2 Viewer readback differs from the packed payload')
        stock_xml = decompile_layout(args.vrf, native, staging / 'stock.xml')
        patched_xml = decompile_layout(args.vrf, staging / 'readback' / LAYOUT, staging / 'patched.xml')
        check_layout_diff(stock_xml, patched_xml)
        script_back = run([args.vrf, '-i', staging / 'readback' / SCRIPT, '-b', 'DATA']).stdout
        if script_text.strip() not in script_back:
            raise SystemExit('Script DATA readback does not contain the bundled script')
        log('readback ok: payload bytes identical, layout = stock + 1 include, script intact')

        vpk_bytes = vpk_path.read_bytes()
        audit = json.loads(audit_path.read_text())
        info = {
            'name': 'Roster Tools', 'version': VERSION, 'build_id': build_id, 'ui_only': True,
            'source_game_build': build, 'native_layout_sha256': fingerprint,
            'layout_fingerprint_known': bool(known),
            'runtime_verified': any(e.get('runtime_verified') for e in known),
            'overrides': [LAYOUT], 'adds': [SCRIPT], 'vpk': vpk_name, 'vpk_sha256': sha256(vpk_bytes),
            'layout_sha256': audit['layout_sha256'], 'script_sha256': audit['script_sha256'],
        }
        info_json = json.dumps(info, indent=2) + '\n'
        zip_name = f'roster-tools-{VERSION}.zip'
        dist = ROOT / 'dist'
        dist.mkdir(exist_ok=True)
        for old in list(dist.glob('pak*_dir.vpk')) + list(dist.glob('roster-tools-*.zip')):
            old.unlink()
        (dist / vpk_name).write_bytes(vpk_bytes)
        (dist / 'roster_tools.js').write_text(script_text, encoding='utf-8')
        (dist / 'build.json').write_text(info_json)
        write_zip(dist / zip_name, [
            (vpk_name, vpk_bytes),
            ('README.txt', release_readme(build, fingerprint_status).encode()),
            ('LICENSE', (ROOT / 'LICENSE').read_bytes()),
            ('build.json', info_json.encode()),
        ])
        (dist / 'SHA256SUMS').write_text(''.join(
            f'{sha256((dist / name).read_bytes())}  {name}\n' for name in (vpk_name, zip_name)))
        log(f'built dist/{zip_name} and dist/{vpk_name} (build {build_id})')
        if not known:
            log('WARNING: the stock layout changed since the last verified build. Test in game, then '
                'add the fingerprint to data/compat.json.')


if __name__ == '__main__':
    main()
