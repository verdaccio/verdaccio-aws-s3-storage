# verdaccio-aws-s3-storage

AWS S3 + DynamoDB storage plugin for [Verdaccio](https://verdaccio.org).

Uses **S3** for package tarballs and metadata, and **DynamoDB** for the registry database (package list, secrets, tokens).

Built with AWS SDK for JavaScript v3.

## Requirements

- **Node.js** >= 24
- **Verdaccio** >= 7.x
- **AWS S3 Bucket** — stores package tarballs and `package.json` metadata
- **AWS DynamoDB Table** — stores the registry state (package list, secret, auth tokens)
  - Partition key: `pk` (String)
  - Sort key: `sk` (String)
  - Billing mode: PAY_PER_REQUEST (recommended) or provisioned
- **AWS Credentials** — via environment variables, IAM role, instance profile, or explicit config

### IAM Permissions

The plugin requires the following IAM permissions:

**S3:**

- `s3:GetObject`
- `s3:PutObject`
- `s3:DeleteObject`
- `s3:DeleteObjects` (for bulk deletes)
- `s3:ListBucket` / `s3:ListObjectsV2`
- `s3:HeadObject`

**DynamoDB:**

- `dynamodb:GetItem`
- `dynamodb:PutItem`
- `dynamodb:DeleteItem`
- `dynamodb:Query`

## Installation

```bash
npm install verdaccio-aws-s3-storage
```

## Configuration

Add to your Verdaccio `config.yaml`:

```yaml
store:
  aws-s3-storage:
    bucket: your-s3-bucket
    keyPrefix: some-prefix # optional, nests all files under a subdirectory
    region: us-east-1 # optional, defaults to AWS SDK default
    endpoint: https://s3.us-east-1.amazonaws.com # optional
    s3ForcePathStyle: false # optional, required for MinIO/LocalStack
    tarballACL: private # optional, use 'public-read' for CDN (e.g. CloudFront)
    accessKeyId: your-key # optional, uses AWS credential chain if omitted
    secretAccessKey: your-secret # optional
    sessionToken: your-token # optional
    proxy: https://your-proxy # optional

    # DynamoDB (required)
    dynamoTableName: verdaccio-registry
    dynamoEndpoint: https://dynamodb.us-east-1.amazonaws.com # optional
    dynamoRegion: us-east-1 # optional, defaults to 'region'
```

### Environment variable substitution

Config values can reference environment variables by name. If the environment variable is set, its value is used; otherwise the literal string is used as-is.

```yaml
store:
  aws-s3-storage:
    bucket: AWS_S3_BUCKET # uses $AWS_S3_BUCKET if set, otherwise literal "AWS_S3_BUCKET"
    keyPrefix: AWS_S3_KEY_PREFIX
    region: AWS_DEFAULT_REGION
    endpoint: AWS_S3_ENDPOINT
    accessKeyId: AWS_ACCESS_KEY_ID
    secretAccessKey: AWS_SECRET_ACCESS_KEY
    sessionToken: AWS_SESSION_TOKEN
    dynamoTableName: AWS_DYNAMO_TABLE_NAME
    dynamoEndpoint: AWS_DYNAMO_ENDPOINT
    dynamoRegion: AWS_DYNAMO_REGION
```

### Environment variables reference

The following environment variables are used by the Docker image and the plugin when config values reference them:

#### S3

| Variable | Required | Description |
|---|---|---|
| `AWS_S3_BUCKET` | Yes | S3 bucket name for storing packages |
| `AWS_S3_KEY_PREFIX` | No | Prefix (subdirectory) for all S3 keys. Default: none |
| `AWS_S3_ENDPOINT` | No | Custom S3 endpoint URL. Required for LocalStack or MinIO. Omit for real AWS |
| `AWS_DEFAULT_REGION` | No | AWS region for S3 and DynamoDB (if `AWS_DYNAMO_REGION` is not set). Default: SDK default |

#### DynamoDB

| Variable | Required | Description |
|---|---|---|
| `AWS_DYNAMO_TABLE_NAME` | Yes | DynamoDB table name (must have `pk`/`sk` key schema) |
| `AWS_DYNAMO_ENDPOINT` | No | Custom DynamoDB endpoint URL. Required for LocalStack. Omit for real AWS |
| `AWS_DYNAMO_REGION` | No | AWS region for DynamoDB. Falls back to `AWS_DEFAULT_REGION` |

#### Authentication

| Variable | Required | Description |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | No | AWS access key. Omit to use IAM roles, instance profiles, or IRSA |
| `AWS_SECRET_ACCESS_KEY` | No | AWS secret key. Required if `AWS_ACCESS_KEY_ID` is set |
| `AWS_SESSION_TOKEN` | No | AWS session token for temporary credentials (STS) |

#### Debug

| Variable | Required | Description |
|---|---|---|
| `DEBUG` | No | Enable [debug](https://www.npmjs.com/package/debug) output. Set to `verdaccio:plugin*` for all plugin namespaces |

Available debug namespaces:

- `verdaccio:plugin:aws-s3-storage:database` — DynamoDB operations (add, remove, get, tokens, secret)
- `verdaccio:plugin:aws-s3-storage:package` — S3 package operations (read, write, create, delete, tarballs)
- `verdaccio:plugin:aws-s3-storage:s3-client` — S3 client initialization
- `verdaccio:plugin:aws-s3-storage:dynamo-client` — DynamoDB client initialization
- `verdaccio:plugin:aws-s3-storage:delete-prefix` — S3 prefix deletion
- `verdaccio:plugin:aws-s3-storage:errors` — AWS error conversion
- `verdaccio:plugin:aws-s3-storage:config` — config value resolution from env vars

### Custom storage per package scope

```yaml
packages:
  '@scope/*':
    access: $all
    publish: $all
    storage: 'scoped' # stored under keyPrefix/scoped/@scope/pkg/
  '**':
    access: $all
    publish: $all
    proxy: npmjs
    storage: 'public'
```

### Tarball ACL

Set `tarballACL: public-read` to grant anonymous read access for CDN integration (e.g. Amazon CloudFront).

## Architecture

```
                   +-----------+
                   | Verdaccio |
                   +-----+-----+
                         |
            +------------+------------+
            |                         |
      S3Database               S3PackageManager
      (registry state)         (per-package storage)
            |                         |
       DynamoDB                      S3
   +-----------------+      +------------------+
   | pk=CONFIG       |      | pkg/package.json |
   | pk=PACKAGE      |      | pkg/tarball.tgz  |
   | pk=TOKEN#user   |      +------------------+
   +-----------------+
```

**S3Database** handles registry operations via DynamoDB:

- Package list (`add`, `remove`, `get`)
- Secret management (`getSecret`, `setSecret`)
- Auth tokens (`saveToken`, `deleteToken`, `readTokens`)

**S3PackageManager** handles per-package operations via S3:

- Package metadata (`readPackage`, `savePackage`, `createPackage`, `deletePackage`)
- Tarballs (`readTarball`, `writeTarball`)

### DynamoDB table schema

Single-table design with partition key `pk` and sort key `sk`:

| pk             | sk              | Description         |
| -------------- | --------------- | ------------------- |
| `CONFIG`       | `SECRET`        | Registry secret key |
| `PACKAGE`      | `{packageName}` | Package entry       |
| `TOKEN#{user}` | `{tokenKey}`    | Auth token          |

## Development

See [LOCAL_DEV.md](LOCAL_DEV.md) for the full local development guide, including:

- Setup, build, test, and lint commands
- Running Verdaccio + LocalStack via Docker Compose
- Inspecting S3 and DynamoDB data in LocalStack
- Debug logging namespaces
- Helm + LocalStack example for Kubernetes

### Creating the DynamoDB table (production)

#### AWS CLI

```bash
aws dynamodb create-table \
  --table-name verdaccio-registry \
  --attribute-definitions \
    AttributeName=pk,AttributeType=S \
    AttributeName=sk,AttributeType=S \
  --key-schema \
    AttributeName=pk,KeyType=HASH \
    AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

#### Terraform

```hcl
resource "aws_dynamodb_table" "verdaccio" {
  name         = "verdaccio-registry"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }
}
```

#### CloudFormation

```yaml
Resources:
  VerdaccioTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: verdaccio-registry
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: pk
          AttributeType: S
        - AttributeName: sk
          AttributeType: S
      KeySchema:
        - AttributeName: pk
          KeyType: HASH
        - AttributeName: sk
          KeyType: RANGE
```

## Scaling & Production Deployment

The plugin is fully stateless and supports horizontal scaling. Run multiple Verdaccio instances behind a load balancer — all instances share the same S3 bucket and DynamoDB table.

- [Scaling guide](docs/scaling.md) — architecture, concurrency safety, ECS/Fargate, Kubernetes, monitoring, cost estimation
- [Helm example](examples/helm/) — deploy on Kubernetes using the official Verdaccio Helm chart with IRSA support

## License

MIT
