#!/bin/bash
# Regenerates assets/music/playlist.json from the audio files in that folder.
cd "$(dirname "$0")/../assets/music" || exit 1
python3 - <<'PY'
import json, os
exts = ('.mp3', '.ogg', '.wav', '.m4a')
files = sorted(f for f in os.listdir('.') if f.lower().endswith(exts) and not f.startswith('.'))
json.dump(files, open('playlist.json', 'w'), indent=2)
print(f"playlist.json: {len(files)} track(s)")
for f in files: print("  " + f)
PY
