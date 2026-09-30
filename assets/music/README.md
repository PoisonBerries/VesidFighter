# Soundtrack

Drop your `.mp3` files (`.ogg`, `.wav` and `.m4a` also work) into this folder.

Then list them in `playlist.json` by running this from the project root:

    ./tools/update-playlist.sh

That rewrites `playlist.json` from whatever audio files are in this folder.
Commit and push the mp3s *and* `playlist.json` together.

The game plays the tracks in a shuffled loop, starting on the first click or
keypress (browsers don't allow audio before that). Players can change the
music and effects volume, mute (M) and skip tracks from the speaker button in
the top-right corner.

Optional: give a track a nicer display name by editing `playlist.json` by hand:

    [ { "file": "boss_theme.mp3", "title": "Boss Theme" }, "other_track.mp3" ]

Tip: keep files reasonably small (128-192 kbps) so the page loads quickly.
