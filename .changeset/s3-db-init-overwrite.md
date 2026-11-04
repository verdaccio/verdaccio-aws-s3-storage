---
'verdaccio-aws-s3-storage': patch
---

Stop overwriting the S3-only database with an empty one when it cannot be read at startup.

With `dynamoTableName: none`, any failure to read `verdaccio-s3-db.json` at startup (a 5xx,
a timeout, a 403, a truncated or invalid JSON body) was treated as a missing file, and the
file was replaced with an empty database. Verdaccio then generated a new secret, which
invalidated every token, and the list of private packages was lost. On a fresh bucket the
extra `HeadObject` request also failed with an unhandled rejection, which ends the process on
current Node versions.

Startup now creates a new database only when S3 reports that the file does not exist (404),
and waits for that write to finish. Any other read error, and a failed write of the new
database, makes startup fail instead of silently wiping the data. Without `s3:ListBucket`,
AWS answers 403 instead of 404 for a missing key, so such setups now fail to start on an
empty bucket instead of creating the database: grant `s3:ListBucket`, or upload
`{"secret": "", "list": [], "tokens": []}` as `<keyPrefix>verdaccio-s3-db.json` before the first start.

Affects 12.1.0 to 12.1.3.
