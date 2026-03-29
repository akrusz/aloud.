# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Glooow desktop app."""

import re
import sys
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# Read version from source so the bundle stays in sync
_version_match = re.search(
    r'__version__\s*=\s*"(.+?)"',
    open("src/__init__.py").read(),
)
APP_VERSION = _version_match.group(1) if _version_match else "0.0.0"

# Platform-appropriate icon
if sys.platform == "darwin":
    _icon = "assets/glooow.icns"
elif sys.platform == "win32":
    _icon = "assets/glooow.ico"
else:
    _icon = None  # Linux doesn't embed icons in the binary

block_cipher = None

a = Analysis(
    ['src/web/__main__.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('src/web/templates', 'src/web/templates'),
        ('src/web/static', 'src/web/static'),
        ('config/default.yaml', 'config'),
        # Piper TTS: espeak-ng-data and tashkeel required for phonemization
        *collect_data_files('piper', include_py_files=False),
    ],
    hiddenimports=[
        'engineio.async_drivers.threading',
        'simple_websocket',
        'pywhispercpp',
        'pywhispercpp.model',
        'pywhispercpp.utils',
        # Piper TTS and its dependencies
        *collect_submodules('piper'),
        *collect_submodules('onnxruntime'),
        *collect_submodules('src.llm'),
        *collect_submodules('src.tts'),
        *collect_submodules('src.facilitation'),
        *collect_submodules('src.stt'),
        *collect_submodules('src.audio'),
        *collect_submodules('src.logging'),
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'torch', 'whisper', 'mlx', 'mlx_whisper',
        'tensorflow', 'tensorboard',
        'matplotlib', 'PIL', 'tkinter',
        'IPython', 'jupyter',
    ],
    noarchive=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='Glooow',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    icon=_icon,
    target_arch=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='Glooow',
)

# macOS app bundle (ignored on other platforms)
if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name='Glooow.app',
        icon='assets/glooow.icns',
        bundle_identifier='com.glooow.app',
        codesign_identity='-',  # ad-hoc sign (required for native libs on macOS)
        info_plist={
            'NSMicrophoneUsageDescription':
                'Glooow needs microphone access for voice-based meditation sessions.',
            'CFBundleShortVersionString': APP_VERSION,
            'CFBundleDisplayName': 'Glooow',
            'NSHighResolutionCapable': True,
        },
    )
