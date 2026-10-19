"""Build the unpacked-extension ZIP from an explicit allowlist; no dependencies."""
from pathlib import Path
import hashlib
import json
import zipfile
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
subprocess.run([sys.executable, str(root / 'scripts' / 'build.py'), '--check'], check=True)
version = json.loads((root / 'manifest.json').read_text())['version']
output = root / 'dist' / f'context-continuation-reminder-{version}.zip'
output.parent.mkdir(exist_ok=True)
files = ['manifest.json', 'page_script.js', 'content.js', 'styles.css',
         'LICENSE', 'README.md', 'PRIVACY.md', 'INSTALL.md', 'docs/VALIDATION.md', 'docs/IMPLEMENTATION_STATUS.md', 'docs/PAGINATION_EVIDENCE.md',
         'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png']
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        data = (root / name).read_bytes()
        info = zipfile.ZipInfo(name, date_time=(2026, 10, 19, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, data)
print(f'{output}\nSHA256 {hashlib.sha256(output.read_bytes()).hexdigest()}')
