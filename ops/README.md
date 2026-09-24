# ops/

The scripts that keep a demo up. All four are idempotent: run one twice and the
second one replaces the first rather than doubling it.

    ./serve.sh              backend on :8090, loads ../.env itself
    ./tunnel.sh             public host, supervised, reconnects to the same address
    ./qr-watch.sh           keeps ~/Desktop/doorway-qr.png pointing at the live URL
    ./synth-when-quota.sh   fills the audio bank when the TTS cap resets

See ../docs/OPERATIONS.md for what breaks without each one, and for the five traps
that cost us a night.
