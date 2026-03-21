# Local Development

Guide for developing and testing the `verdaccio-aws-s3-storage` plugin locally.

## Prerequisites

- Node.js >= 24 (see `.nvmrc`)
- [pnpm](https://pnpm.io/) >= 9
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose (for running Verdaccio + LocalStack)

## Setup

```bash
# Install dependencies
pnpm install

# Type-check
pnpm type-check

# Lint
pnpm lint

# Build (CJS + ESM via Vite 8)
pnpm build

# Run unit tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Format code
pnpm format
```

## Project structure

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
conf/                   # verdaccio config (baked into Docker image)
```

## Running locally with Docker

The included `docker-compose.yaml` provides a full local setup with:

- **LocalStack** (latest) — local AWS cloud with S3 + DynamoDB
- **init-resources** — one-shot container that creates the S3 bucket and DynamoDB table
- **Verdaccio** (`nightly-master`) — runs with the plugin built and installed

### First run

```bash
# Build the plugin image and start everything
docker compose up -d --build

# Verdaccio will be available at http://localhost:4873
```

### What happens on startup

1. LocalStack starts and exposes S3 + DynamoDB on port `4566`
2. `init-resources` waits for LocalStack to be healthy, then creates:
   - S3 bucket: `verdaccio-storage`
   - DynamoDB table: `verdaccio-registry` (pk: String, sk: String, PAY_PER_REQUEST)
3. The `Dockerfile` builds the plugin in a multi-stage build:
   - **Stage 1** (`node:24-alpine`): installs deps with pnpm, runs `vite build`, prunes dev deps
   - **Stage 2** (`verdaccio/verdaccio:nightly-master`): copies `lib/`, `package.json`, and prod `node_modules/` into `/verdaccio/plugins/verdaccio-aws-s3-storage/`
4. Verdaccio starts with the plugin configured to use LocalStack endpoints

### Check it's working

```bash
# Check logs — look for "verdaccio-aws-s3-storage successfully loaded"
docker compose logs verdaccio

# Ping the registry
curl http://localhost:4873/-/ping
```

### Testing the local setup

```bash
# Add a user
npm adduser --registry http://localhost:4873

# Publish a package
npm publish --registry http://localhost:4873

# Install a package
npm install your-package --registry http://localhost:4873
```

### Inspecting LocalStack data

#### S3

```bash
# List all objects in the bucket
docker exec localstack awslocal s3 ls s3://verdaccio-storage/ --recursive

# Download a package.json to inspect it
docker exec localstack awslocal s3 cp s3://verdaccio-storage/packages/my-pkg/package.json -

# Check bucket size
docker exec localstack awslocal s3 ls s3://verdaccio-storage/ --recursive --summarize | tail -2
```

#### DynamoDB

```bash
# Scan all items in the table
docker exec localstack awslocal dynamodb scan --table-name verdaccio-registry

# List all registered packages
docker exec localstack awslocal dynamodb query \
  --table-name verdaccio-registry \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values '{":pk": {"S": "PACKAGE"}}'

# Get the registry secret
docker exec localstack awslocal dynamodb get-item \
  --table-name verdaccio-registry \
  --key '{"pk": {"S": "CONFIG"}, "sk": {"S": "SECRET"}}'

# Query tokens for a user
docker exec localstack awslocal dynamodb query \
  --table-name verdaccio-registry \
  --key-condition-expression "pk = :pk" \
  --expression-attribute-values '{":pk": {"S": "TOKEN#myuser"}}'

# Show table info (item count, schema, size)
docker exec localstack awslocal dynamodb describe-table \
  --table-name verdaccio-registry

# Delete a specific package entry
docker exec localstack awslocal dynamodb delete-item \
  --table-name verdaccio-registry \
  --key '{"pk": {"S": "PACKAGE"}, "sk": {"S": "my-pkg"}}'
```

#### Using the AWS CLI from your host

Port 4566 is exposed by docker-compose, so you can query LocalStack directly from your machine.

Install the AWS CLI if you don't have it:

```bash
# macOS
brew install awscli

# Linux
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install

# or via pip
pip install awscli

# Verify
aws --version
```

Then configure dummy credentials for LocalStack:

```bash
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
```

You can also create a named profile to avoid exporting every time:

```bash
aws configure --profile localstack
# Access Key ID: test
# Secret Access Key: test
# Region: us-east-1
# Output format: json
```

Then use it with `--profile localstack` or set `export AWS_PROFILE=localstack`.

Query LocalStack:

```bash
aws --endpoint-url http://localhost:4566 dynamodb scan --table-name verdaccio-registry
aws --endpoint-url http://localhost:4566 s3 ls s3://verdaccio-storage/ --recursive
```

Tip: create a shell alias to avoid typing the endpoint every time:

```bash
alias awslocal='aws --endpoint-url http://localhost:4566'

awslocal dynamodb scan --table-name verdaccio-registry
awslocal s3 ls s3://verdaccio-storage/ --recursive
```

### Rebuilding after code changes

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

### Stopping and cleaning up

```bash
# Stop all containers
docker compose down

# Stop and remove volumes (wipes LocalStack data)
docker compose down -v
```

## Debug logging

The plugin uses the [`debug`](https://www.npmjs.com/package/debug) package. Enable it with the `DEBUG` environment variable:

```bash
# All plugin namespaces
DEBUG=verdaccio:plugin* docker compose up -d

# Specific namespace only
DEBUG=verdaccio:plugin:aws-s3-storage:database docker compose up -d
```

Available namespaces:

| Namespace | What it logs |
|---|---|
| `verdaccio:plugin:aws-s3-storage:database` | DynamoDB operations (add, remove, get, tokens, secret) |
| `verdaccio:plugin:aws-s3-storage:package` | S3 package operations (read, write, create, delete, tarballs) |
| `verdaccio:plugin:aws-s3-storage:s3-client` | S3 client initialization |
| `verdaccio:plugin:aws-s3-storage:dynamo-client` | DynamoDB client initialization |
| `verdaccio:plugin:aws-s3-storage:delete-prefix` | S3 prefix deletion |
| `verdaccio:plugin:aws-s3-storage:errors` | AWS error conversion |
| `verdaccio:plugin:aws-s3-storage:config` | Config value resolution from env vars |

The plugin also uses Verdaccio's built-in `logger.trace` at key points. Enable it by setting `level: trace` in the verdaccio config (already set in `conf/config.yaml`).

## Helm + LocalStack (Kubernetes)

See [`examples/helm/`](examples/helm/) for a complete example deploying Verdaccio with the plugin on a local Kubernetes cluster (minikube, kind, Docker Desktop) backed by LocalStack.
