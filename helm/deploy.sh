#!/bin/bash

#############################################
# Deploy Script for Strategy Trade Poly
# Deploys application to GKE using Helm
#############################################

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Default values
RELEASE_NAME="strategy-trade-poly"
CHART_PATH="$SCRIPT_DIR/strategy-trade-poly"
NAMESPACE="default"
DRY_RUN=false
WAIT=true
TIMEOUT="10m"

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
    echo "║   Strategy Trade Poly - Deploy Script    ║"
    echo "╚═══════════════════════════════════════════╝"
    echo -e "${NC}"
}

check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check if helm is installed
    if ! command -v helm &> /dev/null; then
        log_error "Helm is not installed. Please install Helm 3+"
        exit 1
    fi
    
    # Check if kubectl is installed
    if ! command -v kubectl &> /dev/null; then
        log_error "kubectl is not installed"
        exit 1
    fi
    
    # Check if connected to kubernetes cluster
    if ! kubectl cluster-info &> /dev/null; then
        log_error "Not connected to any Kubernetes cluster"
        log_info "Run: gcloud container clusters get-credentials CLUSTER_NAME --region REGION"
        exit 1
    fi
    
    # Check if docker is installed
    if ! command -v docker &> /dev/null; then
        log_warning "Docker is not installed. You'll need it to build images."
    fi
    
    log_success "All prerequisites met"
}

select_environment() {
    echo ""
    log_info "Select deployment environment:"
    echo "1) Development (dev)"
    echo "2) Staging"
    echo "3) Production"
    echo ""
    read -p "Enter choice [1-3]: " env_choice
    
    case $env_choice in
        1)
            ENVIRONMENT="dev"
            VALUES_FILE="$CHART_PATH/values.yaml"
            ;;
        2)
            ENVIRONMENT="staging"
            VALUES_FILE="$CHART_PATH/values.staging.yaml"
            if [ ! -f "$VALUES_FILE" ]; then
                log_warning "values.staging.yaml not found, using values.yaml"
                VALUES_FILE="$CHART_PATH/values.yaml"
            fi
            ;;
        3)
            ENVIRONMENT="production"
            VALUES_FILE="$CHART_PATH/values.production.yaml"
            if [ ! -f "$VALUES_FILE" ]; then
                log_error "values.production.yaml not found!"
                log_info "Create it from: cp values.production.example.yaml values.production.yaml"
                exit 1
            fi
            ;;
        *)
            log_error "Invalid choice"
            exit 1
            ;;
    esac
    
    log_success "Environment selected: $ENVIRONMENT"
}

get_image_tag() {
    echo ""
    log_info "Enter Docker image tag (e.g., v1.0.0, latest):"
    read -p "Tag: " IMAGE_TAG
    
    if [ -z "$IMAGE_TAG" ]; then
        log_error "Image tag cannot be empty"
        exit 1
    fi
    
    log_success "Image tag: $IMAGE_TAG"
}

build_and_push_image() {
    echo ""
    read -p "Do you want to build and push Docker image? [y/N]: " build_choice
    
    if [[ "$build_choice" =~ ^[Yy]$ ]]; then
        log_info "Building Docker image..."
        
        cd "$PROJECT_ROOT"
        
        IMAGE_NAME="gcr.io/polylynx/strategy-trade-poly:$IMAGE_TAG"
        
        docker build -t "$IMAGE_NAME" .
        
        if [ $? -eq 0 ]; then
            log_success "Image built successfully"
            
            log_info "Pushing image to GCR..."
            docker push "$IMAGE_NAME"
            
            if [ $? -eq 0 ]; then
                log_success "Image pushed successfully"
            else
                log_error "Failed to push image"
                exit 1
            fi
        else
            log_error "Failed to build image"
            exit 1
        fi
        
        cd "$SCRIPT_DIR"
    fi
}

validate_chart() {
    log_info "Validating Helm chart..."
    
    helm lint "$CHART_PATH"
    
    if [ $? -eq 0 ]; then
        log_success "Chart validation passed"
    else
        log_error "Chart validation failed"
        exit 1
    fi
}

dry_run_deployment() {
    echo ""
    read -p "Do you want to run a dry-run first? [Y/n]: " dryrun_choice
    
    if [[ ! "$dryrun_choice" =~ ^[Nn]$ ]]; then
        log_info "Running dry-run deployment..."
        
        helm install "$RELEASE_NAME" "$CHART_PATH" \
            -f "$VALUES_FILE" \
            --set app.image.tag="$IMAGE_TAG" \
            --namespace "$NAMESPACE" \
            --dry-run --debug
        
        echo ""
        read -p "Does the dry-run output look correct? [Y/n]: " proceed
        
        if [[ "$proceed" =~ ^[Nn]$ ]]; then
            log_warning "Deployment cancelled by user"
            exit 0
        fi
    fi
}

check_existing_release() {
    if helm status "$RELEASE_NAME" -n "$NAMESPACE" &> /dev/null; then
        log_warning "Release '$RELEASE_NAME' already exists in namespace '$NAMESPACE'"
        log_info "Use upgrade.sh to update an existing deployment"
        echo ""
        read -p "Do you want to delete and reinstall? [y/N]: " reinstall
        
        if [[ "$reinstall" =~ ^[Yy]$ ]]; then
            log_info "Uninstalling existing release..."
            helm uninstall "$RELEASE_NAME" -n "$NAMESPACE"
            log_success "Existing release uninstalled"
            sleep 3
        else
            log_info "Deployment cancelled"
            exit 0
        fi
    fi
}

deploy_application() {
    log_info "Deploying application..."
    
    helm install "$RELEASE_NAME" "$CHART_PATH" \
        -f "$VALUES_FILE" \
        --set app.image.tag="$IMAGE_TAG" \
        --namespace "$NAMESPACE" \
        --create-namespace \
        --wait \
        --timeout "$TIMEOUT"
    
    if [ $? -eq 0 ]; then
        log_success "Deployment successful!"
    else
        log_error "Deployment failed!"
        exit 1
    fi
}

show_deployment_info() {
    echo ""
    log_info "Deployment Information:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # Show release status
    helm status "$RELEASE_NAME" -n "$NAMESPACE"
    
    echo ""
    log_info "Pods:"
    kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME"
    
    echo ""
    log_info "Services:"
    kubectl get services -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME"
    
    echo ""
    log_info "Useful commands:"
    echo "  View logs:       kubectl logs -n $NAMESPACE -l app.kubernetes.io/name=strategy-trade-poly --tail=100 -f"
    echo "  Port forward:    kubectl port-forward -n $NAMESPACE svc/strategy-trade-poly 3000:3000"
    echo "  Get pods:        kubectl get pods -n $NAMESPACE -l app.kubernetes.io/instance=$RELEASE_NAME"
    echo "  Describe:        helm status $RELEASE_NAME -n $NAMESPACE"
    echo "  Uninstall:       helm uninstall $RELEASE_NAME -n $NAMESPACE"
}

watch_pods() {
    echo ""
    read -p "Do you want to watch pods status? [y/N]: " watch_choice
    
    if [[ "$watch_choice" =~ ^[Yy]$ ]]; then
        log_info "Watching pods... (Press Ctrl+C to exit)"
        kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" -w
    fi
}

# Main execution
main() {
    print_banner
    
    check_prerequisites
    
    select_environment
    
    get_image_tag
    
    build_and_push_image
    
    validate_chart
    
    dry_run_deployment
    
    check_existing_release
    
    deploy_application
    
    show_deployment_info
    
    watch_pods
    
    echo ""
    log_success "Deployment completed successfully! 🚀"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--namespace)
            NAMESPACE="$2"
            shift 2
            ;;
        -t|--tag)
            IMAGE_TAG="$2"
            shift 2
            ;;
        -e|--environment)
            ENVIRONMENT="$2"
            case $ENVIRONMENT in
                dev|development)
                    VALUES_FILE="$CHART_PATH/values.yaml"
                    ;;
                staging)
                    VALUES_FILE="$CHART_PATH/values.staging.yaml"
                    ;;
                prod|production)
                    VALUES_FILE="$CHART_PATH/values.production.yaml"
                    ;;
                *)
                    log_error "Invalid environment: $ENVIRONMENT"
                    exit 1
                    ;;
            esac
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --no-wait)
            WAIT=false
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -n, --namespace NAME       Kubernetes namespace (default: default)"
            echo "  -t, --tag TAG             Docker image tag"
            echo "  -e, --environment ENV     Environment: dev, staging, production"
            echo "  --dry-run                 Run helm install with --dry-run"
            echo "  --no-wait                 Don't wait for deployment to complete"
            echo "  -h, --help                Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                                    # Interactive mode"
            echo "  $0 -e production -t v1.0.0           # Deploy production with specific tag"
            echo "  $0 -n staging -t latest --dry-run    # Dry run for staging"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Run main function
main

