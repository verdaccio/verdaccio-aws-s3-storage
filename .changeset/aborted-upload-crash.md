---
'verdaccio-aws-s3-storage': patch
---

Prevent an aborted tarball upload from crashing the registry process.

`writeTarball` only awaits the upload promise inside `onEnd()`, which runs on the
stream's `end` event. A client that aborts mid-upload never triggers it, so the
rejection from `upload.done()` reached the process as an `unhandledRejection` and
took the whole registry down. The rejection is now always consumed; the error is
still delivered to the stream via `emit('error')`.
