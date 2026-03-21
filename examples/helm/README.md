# Helm + LocalStack Example

Run a multi-replica Verdaccio registry on Kubernetes with the AWS S3 + DynamoDB storage plugin, fully backed by LocalStack — no AWS account needed.

## Prerequisites

- A local Kubernetes cluster: [minikube](https://minikube.sigs.k8s.io/), [kind](https://kind.sigs.k8s.io/), or Docker Desktop
- [Helm 3](https://helm.sh/docs/intro/install/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)

## 1. Build the plugin image

From the repo root:

```bash
docker build -t verdaccio-aws-s3:local .
```

Load it into your local cluster:

```bash
# minikube
eval $(minikube docker-env)
docker build -t verdaccio-aws-s3:local .

# kind
kind load docker-image verdaccio-aws-s3:local

# Docker Desktop
# No extra step needed — images are shared
```

## 2. Deploy LocalStack

```bash
kubectl apply -f localstack.yaml
```

Wait for it to be ready:

```bash
kubectl -n localstack rollout status deployment/localstack
```

## 3. Create S3 bucket and DynamoDB table

```bash
kubectl apply -f init-resources.yaml
```

Wait for the job to complete:

```bash
kubectl -n localstack wait --for=condition=complete job/init-aws-resources --timeout=60s
```

## 4. Install Verdaccio

```bash
helm repo add verdaccio https://charts.verdaccio.org
helm repo update
helm install verdaccio verdaccio/verdaccio -f values.yaml
```

## 5. Verify

```bash
# Check pods
kubectl get pods -l app.kubernetes.io/name=verdaccio

# Check plugin loaded
kubectl logs -l app.kubernetes.io/name=verdaccio | grep "aws-s3-storage"

# Port-forward
kubectl port-forward svc/verdaccio 4873:4873
```

In another terminal:

```bash
# Ping
curl http://localhost:4873/-/ping

# Add user
npm adduser --registry http://localhost:4873

# Create and publish a test package
mkdir /tmp/helm-test && cd /tmp/helm-test
echo '{"name":"helm-test-pkg","version":"1.0.0"}' > package.json
npm publish --registry http://localhost:4873

# Verify it's stored
curl -s http://localhost:4873/helm-test-pkg | jq .name
```

## 6. Scale up

Edit `values.yaml` and change `replicaCount`, or:

```bash
kubectl scale deployment verdaccio --replicas=3
```

All replicas share the same LocalStack S3 bucket and DynamoDB table.

## 7. Inspect LocalStack data

```bash
# Port-forward LocalStack
kubectl -n localstack port-forward svc/localstack 4566:4566

# List S3 objects
aws --endpoint-url http://localhost:4566 s3 ls s3://verdaccio-storage/ --recursive

# Scan DynamoDB
aws --endpoint-url http://localhost:4566 dynamodb scan --table-name verdaccio-registry
```

## 8. Clean up

```bash
helm uninstall verdaccio
kubectl delete -f init-resources.yaml
kubectl delete -f localstack.yaml
```

## File overview

| File                  | Description                                                                 |
| --------------------- | --------------------------------------------------------------------------- |
| `values.yaml`         | Helm values for Verdaccio — 2 replicas, LocalStack endpoints, trace logging |
| `localstack.yaml`     | Deployment + Service for LocalStack (S3 + DynamoDB) in its own namespace    |
| `init-resources.yaml` | Job that creates the S3 bucket and DynamoDB table in LocalStack             |
