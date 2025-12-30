#!/bin/bash

#############################################
# Refresh GCR Secret Script
# Updates the GCR authentication secret with a fresh token
#############################################

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
NAMESPACE="default"
SECRET_NAME="gcr-json-key"
DOCKER_EMAIL="duyphan9696@gmail.com"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_banner() {
    echo -e "${GREEN}"
    echo "╔═══════════════════════════════════════════╗"
    echo "║   Refresh GCR Secret                      ║"
    echo "╚═══════════════════════════════════════════╝"
    echo -e "${NC}"
}

check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if ! command -v gcloud &> /dev/null; then
        log_error "gcloud is not installed"
        exit 1
    fi
    
    if ! command -v kubectl &> /dev/null; then
        log_error "kubectl is not installed"
        exit 1
    fi
    
    if ! kubectl cluster-info &> /dev/null; then
        log_error "Not connected to Kubernetes cluster"
        exit 1
    fi
    
    log_success "Prerequisites check passed"
}

refresh_secret() {
    log_info "Getting fresh access token from gcloud..."
    
    TOKEN=$(gcloud auth print-access-token 2>/dev/null)
    
    if [ -z "$TOKEN" ]; then
        log_error "Failed to get access token. Please run: gcloud auth login"
        exit 1
    fi
    
    log_success "Access token obtained"
    
    # Check if secret exists
    if kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" &> /dev/null; then
        log_info "Deleting existing secret..."
        kubectl delete secret "$SECRET_NAME" -n "$NAMESPACE"
    fi
    
    log_info "Creating new secret..."
    kubectl create secret docker-registry "$SECRET_NAME" \
        --docker-server=gcr.io \
        --docker-username=oauth2accesstoken \
        --docker-password="$TOKEN" \
        --docker-email="$DOCKER_EMAIL" \
        -n "$NAMESPACE"
    
    if [ $? -eq 0 ]; then
        log_success "Secret '$SECRET_NAME' created successfully!"
    else
        log_error "Failed to create secret"
        exit 1
    fi
}

restart_failed_pods() {
    log_info "Checking for failed pods..."
    
    FAILED_PODS=$(kubectl get pods -n "$NAMESPACE" -l app=strategy-trade-poly --field-selector=status.phase!=Running,status.phase!=Succeeded -o name 2>/dev/null || echo "")
    
    if [ -n "$FAILED_PODS" ]; then
        log_warning "Found failed pods, restarting them..."
        echo "$FAILED_PODS" | xargs kubectl delete -n "$NAMESPACE" 2>/dev/null || true
        log_success "Failed pods deleted, they will be recreated automatically"
    else
        log_info "No failed pods found"
    fi
}

show_status() {
    echo ""
    log_info "Current pods status:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    kubectl get pods -n "$NAMESPACE" -l app=strategy-trade-poly
    echo ""
}

# Main execution
print_banner
check_prerequisites
refresh_secret
restart_failed_pods
show_status

echo ""
log_success "Done! GCR secret has been refreshed"
log_info "Note: OAuth tokens expire after 1 hour. For long-term use, consider using Service Account keys."










