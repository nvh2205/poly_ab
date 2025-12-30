#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ID="${PROJECT_ID:-polylynx}"
REGION="${REGION:-us-central1}"
CLUSTER_NAME="${CLUSTER_NAME:-}"
VALUES_FILE="./helm/strategy-trade-poly/values.yaml"

# Functions
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Get cluster name and region from values.yaml if not set as environment variables
if [ -f "$VALUES_FILE" ]; then
    if [ -z "$CLUSTER_NAME" ]; then
        CLUSTER_NAME=$(grep "clusterName:" "$VALUES_FILE" | head -1 | sed -E 's/.*clusterName:[[:space:]]*"?([^"]+)"?.*/\1/' | tr -d ' ' | tr -d '"' | tr -d "'")
    fi
    if [ -z "$REGION" ]; then
        REGION=$(grep "region:" "$VALUES_FILE" | grep -v "#" | head -1 | sed -E 's/.*region:[[:space:]]*"?([^"]+)"?.*/\1/' | tr -d ' ' | tr -d '"' | tr -d "'")
    fi
    if [ -z "$PROJECT_ID" ]; then
        PROJECT_ID=$(grep "projectId:" "$VALUES_FILE" | head -1 | sed -E 's/.*projectId:[[:space:]]*"?([^"]+)"?.*/\1/' | tr -d ' ' | tr -d '"' | tr -d "'")
    fi
fi

# Validate cluster name
if [ -z "$CLUSTER_NAME" ]; then
    print_error "CLUSTER_NAME is not set. Please set it or check values.yaml"
    exit 1
fi

# Set defaults if still empty
REGION="${REGION:-us-central1}"
PROJECT_ID="${PROJECT_ID:-polylynx}"

print_info "Using configuration:"
print_info "  Project ID: $PROJECT_ID"
print_info "  Region: $REGION"
print_info "  Cluster Name: $CLUSTER_NAME"

# Authenticate with GCP (optional if already authenticated, but good for safety)
print_info "Ensuring GKE credentials..."
gcloud container clusters get-credentials $CLUSTER_NAME --region $REGION --project $PROJECT_ID

# Uninstall Helm release
RELEASE_NAME="strategy-trade-poly"
if helm list -n default | grep -q "$RELEASE_NAME"; then
    print_info "Uninstalling Helm release $RELEASE_NAME..."
    helm uninstall $RELEASE_NAME -n default
    print_info "Helm release uninstalled."
else
    print_warn "Helm release $RELEASE_NAME not found."
fi

# Delete manual secrets if they exist
SECRET_NAME="gcr-json-key"
if kubectl get secret "$SECRET_NAME" -n default > /dev/null 2>&1; then
    print_info "Deleting secret $SECRET_NAME..."
    kubectl delete secret "$SECRET_NAME" -n default
    print_info "Secret $SECRET_NAME deleted."
else
    print_info "Secret $SECRET_NAME not found."
fi

# Optional: Check for lingering resources (PVCs sometimes persist if configured to)
# But our PVCs don't have resource-policy: keep, so they should be gone.
# We'll double check.

print_info "Checking for remaining resources..."
REMAINING_PODS=$(kubectl get pods -l app.kubernetes.io/instance=$RELEASE_NAME -n default --no-headers 2>/dev/null | wc -l || echo 0)

if [ "$REMAINING_PODS" -gt 0 ]; then
    print_warn "Some pods are still terminating. Use 'kubectl get pods' to monitor."
else
    print_info "No pods remaining."
fi

print_info "Clear app complete!"

