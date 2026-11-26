---
'verdaccio-aws-s3-storage': patch
---

Keep the package list consistent when several instances share one bucket without DynamoDB.

With `dynamoTableName: none`, every instance read `verdaccio-s3-db.json` once at startup and
wrote its whole in-memory copy back on each change. With two or more instances, a package
added on one instance was dropped from `list` when another instance added a different one,
each instance listed only the packages it had seen itself, and a whole-package unpublish on an
instance that had never seen the package left its name in `list`.

`add()`, `remove()` and `setSecret()` now read the database from S3, apply the change to that
copy and write it only when something changed, one change at a time per process. `get()` and
`search()` read the list from S3 and fall back to the in-memory copy if the read fails.

New optional setting `conditionalWrites` (default `false`): the write is sent with `If-Match`
and retried on `412` with a fresh copy, up to 5 attempts. Enable it only on stores that
enforce `If-Match` on `PutObject` (AWS S3, MinIO).
