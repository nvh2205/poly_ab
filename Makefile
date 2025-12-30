.PHONY: help build push deploy secret clean logs status

# Default project settings
PROJECT_ID ?= polylynx
CLUSTER_NAME ?= cluster-1
REGION ?= us-central1
NAMESPACE ?= default
VERSION ?= latest
IMAGE_NAME = strategy-trade-poly
FULL_IMAGE = gcr.io/$(PROJECT_ID)/$(IMAGE_NAME):$(VERSION)

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

auth: ## Authenticate with Google Cloud
	@echo "Authenticating with Google Cloud..."
	gcloud auth login
	gcloud config set project $(PROJECT_ID)
	gcloud auth configure-docker gcr.io

build: ## Build Docker image locally
	@echo "Building Docker image: $(FULL_IMAGE) for linux/amd64"
	docker build --platform linux/amd64 -t $(FULL_IMAGE) .

push: build ## Build and push Docker image to GCR
	@echo "Pushing image to GCR: $(FULL_IMAGE)"
	docker push $(FULL_IMAGE)
	@if [ "$(VERSION)" != "latest" ]; then \
		docker tag $(FULL_IMAGE) gcr.io/$(PROJECT_ID)/$(IMAGE_NAME):latest; \
		docker push gcr.io/$(PROJECT_ID)/$(IMAGE_NAME):latest; \
	fi

secret: ## Create GCR ImagePullSecret (for development)
	@echo "Creating GCR ImagePullSecret in namespace: $(NAMESPACE)"
	@kubectl create namespace $(NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
	@kubectl delete secret gcr-json-key -n $(NAMESPACE) --ignore-not-found
	@kubectl create secret docker-registry gcr-json-key \
		--docker-server=gcr.io \
		--docker-username=oauth2accesstoken \
		--docker-password="$$(gcloud auth print-access-token)" \
		--docker-email="$$(gcloud config get-value account)" \
		--namespace=$(NAMESPACE)
	@echo "✓ Secret created (expires in ~1 hour)"

secret-prod: ## Create GCR ImagePullSecret using service account (for production)
	@echo "Create service account first with:"
	@echo "  gcloud iam service-accounts create gcr-reader --display-name='GCR Image Puller'"
	@echo "  gcloud projects add-iam-policy-binding $(PROJECT_ID) \\"
	@echo "    --member='serviceAccount:gcr-reader@$(PROJECT_ID).iam.gserviceaccount.com' \\"
	@echo "    --role='roles/storage.objectViewer'"
	@echo "  gcloud iam service-accounts keys create ~/gcr-key.json \\"
	@echo "    --iam-account=gcr-reader@$(PROJECT_ID).iam.gserviceaccount.com"
	@echo ""
	@read -p "Enter path to service account JSON key: " KEY_FILE; \
	kubectl create secret docker-registry gcr-json-key \
		--docker-server=gcr.io \
		--docker-username=_json_key \
		--docker-password="$$(cat $$KEY_FILE)" \
		--docker-email=your-email@example.com \
		--namespace=$(NAMESPACE)

get-credentials: ## Get GKE cluster credentials
	@echo "Getting GKE credentials for cluster: $(CLUSTER_NAME)"
	gcloud container clusters get-credentials $(CLUSTER_NAME) \
		--region=$(REGION) \
		--project=$(PROJECT_ID)

deploy: get-credentials ## Deploy to GKE with Helm
	@echo "Deploying to GKE..."
	@echo "Cluster: $(CLUSTER_NAME)"
	@echo "Namespace: $(NAMESPACE)"
	@echo "Image: $(FULL_IMAGE)"
	helm upgrade --install $(IMAGE_NAME) ./helm/$(IMAGE_NAME) \
		--namespace=$(NAMESPACE) \
		--create-namespace \
		--set app.image.repository=gcr.io/$(PROJECT_ID)/$(IMAGE_NAME) \
		--set app.image.tag=$(VERSION) \
		--set global.projectId=$(PROJECT_ID) \
		--set global.region=$(REGION) \
		--set global.clusterName=$(CLUSTER_NAME) \
		--wait \
		--timeout=5m
	@echo "✓ Deployment completed!"

deploy-prod: get-credentials ## Deploy to production with production values
	@echo "Deploying to production..."
	helm upgrade --install $(IMAGE_NAME) ./helm/$(IMAGE_NAME) \
		--namespace=production \
		--create-namespace \
		-f helm/$(IMAGE_NAME)/values.production.example.yaml \
		--set app.image.repository=gcr.io/$(PROJECT_ID)/$(IMAGE_NAME) \
		--set app.image.tag=$(VERSION) \
		--wait \
		--timeout=5m

status: ## Check deployment status
	@echo "Checking deployment status..."
	@echo ""
	@echo "=== Pods ==="
	kubectl get pods -n $(NAMESPACE) -l app=$(IMAGE_NAME)
	@echo ""
	@echo "=== Services ==="
	kubectl get svc -n $(NAMESPACE)
	@echo ""
	@echo "=== Ingress ==="
	kubectl get ingress -n $(NAMESPACE)

logs: ## View application logs
	kubectl logs -f -n $(NAMESPACE) -l app=$(IMAGE_NAME) --max-log-requests=10

logs-pod: ## View logs of specific pod (use POD=<pod-name>)
	kubectl logs -f -n $(NAMESPACE) $(POD)

shell: ## Open shell in application pod
	@POD=$$(kubectl get pods -n $(NAMESPACE) -l app=$(IMAGE_NAME) -o jsonpath='{.items[0].metadata.name}'); \
	echo "Opening shell in pod: $$POD"; \
	kubectl exec -it -n $(NAMESPACE) $$POD -- /bin/sh

describe: ## Describe application pods
	@POD=$$(kubectl get pods -n $(NAMESPACE) -l app=$(IMAGE_NAME) -o jsonpath='{.items[0].metadata.name}'); \
	kubectl describe pod -n $(NAMESPACE) $$POD

restart: ## Restart deployment
	kubectl rollout restart deployment/$(IMAGE_NAME) -n $(NAMESPACE)
	kubectl rollout status deployment/$(IMAGE_NAME) -n $(NAMESPACE)

rollback: ## Rollback to previous version
	helm rollback $(IMAGE_NAME) -n $(NAMESPACE)

clean: ## Delete deployment
	@echo "Deleting deployment..."
	helm uninstall $(IMAGE_NAME) -n $(NAMESPACE) || true
	kubectl delete secret gcr-json-key -n $(NAMESPACE) --ignore-not-found

clean-all: clean ## Delete deployment and PVCs
	kubectl delete pvc -n $(NAMESPACE) --all

# Complete deployment flow
all: push secret deploy status ## Complete flow: build, push, create secret, deploy

# Quick commands
quick-deploy: ## Quick redeploy after code changes
	@echo "Quick redeploy..."
	$(MAKE) push VERSION=latest
	$(MAKE) restart
	@echo "Waiting for deployment..."
	sleep 5
	$(MAKE) logs

test-deployment: ## Run deployment tests
	@./test-deployment.sh

# Testing
test-local: ## Test build locally
	docker build -t $(IMAGE_NAME):test .
	docker run --rm -p 3000:3000 \
		-e NODE_ENV=development \
		-e DB_HOST=host.docker.internal \
		-e DB_PORT=5432 \
		-e DB_USERNAME=polymarket \
		-e DB_PASSWORD=postgres \
		-e DB_DATABASE=polymarket_db \
		-e REDIS_HOST=host.docker.internal \
		-e REDIS_PORT=6379 \
		$(IMAGE_NAME):test

# Monitoring
top: ## Show resource usage
	kubectl top pods -n $(NAMESPACE) -l app=$(IMAGE_NAME)

events: ## Show recent events
	kubectl get events -n $(NAMESPACE) --sort-by='.lastTimestamp'

# Database operations
db-shell: ## Open PostgreSQL shell
	@POD=$$(kubectl get pods -n $(NAMESPACE) -l app=postgresql -o jsonpath='{.items[0].metadata.name}'); \
	echo "Opening PostgreSQL shell in pod: $$POD"; \
	kubectl exec -it -n $(NAMESPACE) $$POD -- psql -U polymarket -d polymarket_db

redis-shell: ## Open Redis CLI
	@POD=$$(kubectl get pods -n $(NAMESPACE) -l app=redis -o jsonpath='{.items[0].metadata.name}'); \
	echo "Opening Redis CLI in pod: $$POD"; \
	kubectl exec -it -n $(NAMESPACE) $$POD -- redis-cli

# Port forwarding
port-forward-app: ## Forward app port to localhost:3000
	@POD=$$(kubectl get pods -n $(NAMESPACE) -l app=$(IMAGE_NAME) -o jsonpath='{.items[0].metadata.name}'); \
	echo "Forwarding port from pod: $$POD"; \
	kubectl port-forward -n $(NAMESPACE) $$POD 3000:3000

port-forward-db: ## Forward PostgreSQL port to localhost:5432
	@POD=$$(kubectl get pods -n $(NAMESPACE) -l app=postgresql -o jsonpath='{.items[0].metadata.name}'); \
	kubectl port-forward -n $(NAMESPACE) $$POD 5432:5432

port-forward-redis: ## Forward Redis port to localhost:6379
	@POD=$$(kubectl get pods -n $(NAMESPACE) -l app=redis -o jsonpath='{.items[0].metadata.name}'); \
	kubectl port-forward -n $(NAMESPACE) $$POD 6379:6379

