#!/usr/bin/env python3
"""Run after `npx cap add android`: launcher icons, camera permission, version numbers."""
import os, re, shutil, sys

root = os.path.dirname(os.path.abspath(__file__))
app = os.path.join(root, 'android', 'app')
run = sys.argv[1] if len(sys.argv) > 1 else '1'

# 1) launcher icons (logo of Pyramids Poultry) + white adaptive background
res_src = os.path.join(root, 'res-overrides')
res_dst = os.path.join(app, 'src', 'main', 'res')
for dp, _, files in os.walk(res_src):
    rel = os.path.relpath(dp, res_src)
    os.makedirs(os.path.join(res_dst, rel), exist_ok=True)
    for f in files:
        shutil.copy2(os.path.join(dp, f), os.path.join(res_dst, rel, f))
print('icons copied')

# 2) camera permission (complaint photos, QR scanning) - optional hardware
mf = os.path.join(app, 'src', 'main', 'AndroidManifest.xml')
x = open(mf, encoding='utf-8').read()
if 'android.permission.CAMERA' not in x:
    add = ('    <uses-permission android:name="android.permission.CAMERA" />\n'
           '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n'
           '    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />\n\n    ')
    x = x.replace('<application', add + '<application', 1)
    open(mf, 'w', encoding='utf-8').write(x)
print('manifest ok')

# 3) version numbers: every build gets a higher versionCode so it installs over the previous one
for name in ('build.gradle',):
    p = os.path.join(app, name)
    g = open(p, encoding='utf-8').read()
    g = re.sub(r'versionCode\s+\d+', 'versionCode ' + run, g, count=1)
    g = re.sub(r'versionName\s+"[^"]*"', 'versionName "1.%s"' % run, g, count=1)
    open(p, 'w', encoding='utf-8').write(g)
print('version', run)
