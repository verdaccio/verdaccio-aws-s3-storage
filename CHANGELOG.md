# verdaccio-aws-s3-storage

## 12.1.3

### Patch Changes

- 18eb0b8: Migrate the release workflow to Changesets action v2 and CLI v3.

## 12.1.2

### Patch Changes

- 602a16d: Prevent an aborted tarball upload from crashing the registry process.

  `writeTarball` only awaits the upload promise inside `onEnd()`, which runs on the
  stream's `end` event. A client that aborts mid-upload never triggers it, so the
  rejection from `upload.done()` reached the process as an `unhandledRejection` and
  took the whole registry down. The rejection is now always consumed; the error is
  still delivered to the stream via `emit('error')`.

- 19c0dbb: Update runtime dependencies: `@verdaccio/core` and `@verdaccio/config` to
  `9.0.0-next-9.32`, and the AWS SDK v3 packages to `3.1097.0`. These are external
  imports in the published bundle, so a release is needed for consumers to pick them up.

## 12.1.1

### Patch Changes

- a73a893: chore: force release with env

## 12.1.0

### Minor Changes

- a311a32: feat: use S3 for registry DB (alternative to DynamoDB)

## 12.0.4

### Patch Changes

- 5d465ff: chore: release bump

## 12.0.3

### Patch Changes

- 73152e7: fix: build package before publishing so `lib/` is included in the published tarball

## 12.0.2

### Patch Changes

- ec1b76e: fix: ignore files

## 12.0.1

### Patch Changes

- b4ece09: fix: search endpoint support for verdaccio 7 callback pattern
- 39bff09: refactor: pure ESM package, drop CJS output

## 12.0.0

### Major Changes

- 33f01ff: feat: release next major
