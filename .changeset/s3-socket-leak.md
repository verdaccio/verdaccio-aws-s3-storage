---
'verdaccio-aws-s3-storage': patch
---

Release S3 GetObject sockets when a tarball read is aborted or destroyed, including reads cancelled through the abort signal Verdaccio 9 passes to the storage, and add optional `connectionTimeout`, `requestTimeout`, `socketTimeout` and `maxSockets`.
