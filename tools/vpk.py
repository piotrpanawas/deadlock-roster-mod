"""Deterministic single-file VPK writer and a small index reader (no dependencies)."""
from pathlib import Path, PurePosixPath
import struct
import zlib

VPK_SIGNATURE = 0x55AA1234
INLINE_ARCHIVE = 0x7FFF


def pack(files: dict[str, bytes], output: Path) -> None:
    """Write a VPK v1 with all data stored after the directory tree."""
    groups: dict[str, dict[str, list[tuple[str, bytes]]]] = {}
    for filename, data in sorted(files.items()):
        path = PurePosixPath(filename)
        if ('\0' in filename or '\\' in filename or filename != path.as_posix() or filename != filename.lower()
                or path.is_absolute() or '..' in path.parts or not path.suffix):
            raise ValueError(f'Unsafe VPK entry: {filename}')
        directory = str(path.parent) if str(path.parent) != '.' else ' '
        groups.setdefault(path.suffix[1:], {}).setdefault(directory, []).append((path.stem, data))
    tree = bytearray()
    payload = bytearray()
    for extension, directories in sorted(groups.items()):
        tree += extension.encode() + b'\0'
        for directory, entries in sorted(directories.items()):
            tree += directory.encode() + b'\0'
            for name, data in entries:
                tree += name.encode() + b'\0'
                tree += struct.pack('<IHHIIH', zlib.crc32(data), 0, INLINE_ARCHIVE, len(payload), len(data), 0xFFFF)
                payload += data
            tree += b'\0'
        tree += b'\0'
    tree += b'\0'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(struct.pack('<III', VPK_SIGNATURE, 1, len(tree)) + bytes(tree) + bytes(payload))


def read_index(path: Path) -> list[str]:
    """File paths listed in a VPK v1/v2 directory tree."""
    buf = path.read_bytes()
    signature, version, _ = struct.unpack_from('<III', buf)
    if signature != VPK_SIGNATURE:
        raise ValueError(f'{path} is not a VPK')
    offset = 28 if version == 2 else 12
    out = []

    def string() -> str:
        nonlocal offset
        end = buf.index(b'\0', offset)
        text = buf[offset:end].decode('latin-1')
        offset = end + 1
        return text

    while extension := string():
        while directory := string():
            while name := string():
                preload = struct.unpack_from('<H', buf, offset + 4)[0]
                offset += 18 + preload
                out.append(('' if directory == ' ' else directory + '/') + name + '.' + extension)
    return out
