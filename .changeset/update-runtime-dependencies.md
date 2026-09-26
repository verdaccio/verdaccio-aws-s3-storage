---
'verdaccio-aws-s3-storage': patch
---

Update runtime dependencies: `@verdaccio/core` and `@verdaccio/config` to
`9.0.0-next-9.32`, and the AWS SDK v3 packages to `3.1097.0`. These are external
imports in the published bundle, so a release is needed for consumers to pick them up.
