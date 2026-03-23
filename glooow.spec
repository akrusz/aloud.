# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Glooow desktop app."""

from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

a = Analysis(
    ['src/web/__main__.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('src/web/templates', 'src/web/templates'),
        ('src/web/static', 'src/web/static'),
        ('config/default.yaml', 'config'),
    ],
    hiddenimports=[
        'engineio.async_drivers.threading',
        'simple_websocket',
        'pywhispercpp',
        'pywhispercpp.model',
        'pywhispercpp.utils',
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

app = BUNDLE(
    coll,
    name='Glooow.app',
    icon='assets/glooow.icns',
    bundle_identifier='com.glooow.app',
    codesign_identity='-',  # ad-hoc sign (required for native libs on macOS)
    info_plist={
        'NSMicrophoneUsageDescription':
            'Glooow needs microphone access for voice-based meditation sessions.',
        'CFBundleShortVersionString': '0.9.1',
        'CFBundleDisplayName': 'Glooow',
        'NSHighResolutionCapable': True,
    },
)
