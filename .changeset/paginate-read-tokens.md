---
'verdaccio-aws-s3-storage': patch
---

Paginate `readTokens` so tokens past DynamoDB's 1MB Query cap stay visible

`readTokens` issued a single `QueryCommand` and used `result.Items`
directly. DynamoDB truncates a Query response at 1MB and signals the
remainder with `LastEvaluatedKey`, so a user with enough token records
got back only the lexicographically earliest subset. Verdaccio then
reported any token sorting after the cutoff as missing and answered 403
to an otherwise valid request. The read now follows `LastEvaluatedKey`
to completion.
