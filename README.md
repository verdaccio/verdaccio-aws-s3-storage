# verdaccio-aws-s3-storage

AWS S3 + DynamoDB storage plugin for [Verdaccio](https://verdaccio.org).

Uses **S3** for package tarballs and metadata, and **DynamoDB** for the registry database (package list, secrets, tokens).

Built with AWS SDK for JavaScript v3.

## Requirements

- **Node.js** >= 24
- **Verdaccio** >= 67.x
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
    bucket: S3_BUCKET # uses $S3_BUCKET if set, otherwise literal "S3_BUCKET"
    keyPrefix: S3_KEY_PREFIX
    region: AWS_REGION
    accessKeyId: AWS_ACCESS_KEY_ID
    secretAccessKey: AWS_SECRET_ACCESS_KEY
    sessionToken: AWS_SESSION_TOKEN
    dynamoTableName: DYNAMO_TABLE_NAME
```

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

### Prerequisites

- Node.js >= 24 (see `.nvmrc`)
- [pnpm](https://pnpm.io/) >= 9
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose (for local testing)

### Setup

```bash
# Install dependencies
pnpm install

# Type-check
pnpm type-check

# Build
pnpm build

# Run unit tests
pnpm test

# Run tests in watch mode
pnpm test:watch
```

### Project structure

```
src/
  index.ts              # barrel export
  s3Database.ts         # registry database (DynamoDB)
  s3PackageManager.ts   # package storage (S3)
  s3Client.ts           # S3Client factory
  dynamoClient.ts       # DynamoDB DocumentClient factory
  s3Errors.ts           # AWS error → VerdaccioError conversion
  deleteKeyPrefix.ts    # S3 prefix deletion helper
  addTrailingSlash.ts   # path utility
  setConfigValue.ts     # env var resolution
types/
  index.ts              # S3Config interface
tests/                  # unit tests (vitest 4)
conf/                   # local dev verdaccio config
```

### Running locally with Docker

The included `docker-compose.yaml` provides a full local setup with:

- **LocalStack** (latest) — local AWS cloud with S3 + DynamoDB
- **init-resources** — one-shot container that creates the S3 bucket and DynamoDB table
- **Verdaccio** (`nightly-master`) — runs with the plugin built and installed

#### First run

```bash
# Build the plugin image and start everything
docker compose up -d --build

# Verdaccio will be available at http://localhost:4873
```

#### What happens on startup

1. LocalStack starts and exposes S3 + DynamoDB on port `4566`
2. `init-resources` waits for LocalStack to be healthy, then creates:
   - S3 bucket: `verdaccio-storage`
   - DynamoDB table: `verdaccio-registry` (pk: String, sk: String, PAY_PER_REQUEST)
3. The `Dockerfile` builds the plugin in a multi-stage build:
   - **Stage 1** (`node:24-alpine`): installs deps with pnpm, runs `vite build`, prunes dev deps
   - **Stage 2** (`verdaccio/verdaccio:nightly-master`): copies `lib/`, `package.json`, and prod `node_modules/` into `/verdaccio/plugins/verdaccio-aws-s3-storage/`
4. Verdaccio starts with the plugin configured to use LocalStack endpoints

#### Check it's working

```bash
# Check logs — look for "verdaccio-aws-s3-storage successfully loaded"
docker compose logs verdaccio

# Ping the registry
curl http://localhost:4873/-/ping
```

#### Testing the local setup

```bash
# Add a user
npm adduser --registry http://localhost:4873

# Publish a package
npm publish --registry http://localhost:4873

# Install a package
npm install your-package --registry http://localhost:4873

# Verify data landed in S3
docker exec localstack awslocal s3 ls s3://verdaccio-storage/ --recursive

# Verify data in DynamoDB
docker exec localstack awslocal dynamodb scan --table-name verdaccio-registry
```

#### Rebuilding after code changes

After modifying source code in `src/` or `types/`, rebuild the verdaccio image and restart:

```bash
# Rebuild only the verdaccio service (uses Docker cache for unchanged layers)
docker compose build verdaccio

# Restart with the new image
docker compose up -d

# Or do both in one command
docker compose up -d --build
```

To force a clean rebuild (no cache):

```bash
docker compose build --no-cache verdaccio
docker compose up -d
```

#### Stopping and cleaning up

```bash
# Stop all containers
docker compose down

# Stop and remove volumes (wipes LocalStack data)
docker compose down -v
```

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

## License

MIT
