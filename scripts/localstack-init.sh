#!/bin/bash
set -euo pipefail

ENDPOINT="http://localstack:4566"
REGION="us-east-1"

echo "Waiting for LocalStack to be ready..."
until curl -sf "${ENDPOINT}/_localstack/health" | grep -q '"s3": "running"'; do
  sleep 2
done
echo "LocalStack is ready."

echo "Creating S3 bucket..."
aws --endpoint-url "$ENDPOINT" --region "$REGION" \
  s3 mb s3://verdaccio-storage 2>/dev/null || echo "Bucket already exists"

echo "Creating DynamoDB table..."
aws --endpoint-url "$ENDPOINT" --region "$REGION" \
  dynamodb create-table \
    --table-name verdaccio-registry \
    --attribute-definitions \
      AttributeName=pk,AttributeType=S \
      AttributeName=sk,AttributeType=S \
    --key-schema \
      AttributeName=pk,KeyType=HASH \
      AttributeName=sk,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
  2>/dev/null || echo "Table already exists"

echo "Resources created successfully."
