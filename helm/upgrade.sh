#!/bin/bash

#############################################
# Upgrade Script for Strategy Trade Poly
# Upgrades existing deployment on GKE
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
TIMEOUT="15m"
AUTO_ROLLBACK=false
BACKUP_DB=false

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
    echo "║   Strategy Trade Poly - Upgrade Script   ║"
    echo "╚═══════════════════════════════════════════╝"
    echo -e "${NC}"
}

check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if ! command -v helm &> /dev/null; then
        log_error "Helm is not installed"
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

check_release_exists() {
    log_info "Checking if release exists..."
    
    if ! helm status "$RELEASE_NAME" -n "$NAMESPACE" &> /dev/null; then
        log_error "Release '$RELEASE_NAME' not found in namespace '$NAMESPACE'"
        log_info "Use deploy.sh to create a new deployment"
        exit 1
    fi
    
    log_success "Release found"
}

show_current_status() {
    echo ""
    log_info "Current deployment status:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # Show current release info
    helm status "$RELEASE_NAME" -n "$NAMESPACE" | head -n 20
    
    # Show history
    echo ""
    log_info "Deployment history:"
    helm history "$RELEASE_NAME" -n "$NAMESPACE"
    
    # Show current pods
    echo ""
    log_info "Current pods:"
    kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME"
}

get_current_image() {
    CURRENT_IMAGE=$(kubectl get deployment -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" -o jsonpath='{.items[0].spec.template.spec.containers[0].image}' 2>/dev/null || echo "")
    if [ -z "$CURRENT_IMAGE" ]; then
        log_warning "Could not retrieve current image (deployment may not exist yet)"
    else
        log_info "Current image: $CURRENT_IMAGE"
    fi
}

get_new_image_tag() {
    echo ""
    log_info "Enter new Docker image tag (e.g., v1.1.0):"
    read -p "Tag: " NEW_IMAGE_TAG
    
    if [ -z "$NEW_IMAGE_TAG" ]; then
        log_error "Image tag cannot be empty"
        exit 1
    fi
    
    log_success "New image tag: $NEW_IMAGE_TAG"
}

select_environment() {
    echo ""
    log_info "Select environment configuration:"
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
                exit 1
            fi
            ;;
        *)
            log_error "Invalid choice"
            exit 1
            ;;
    esac
    
    log_success "Environment: $ENVIRONMENT"
}

build_and_push_image() {
    echo ""
    read -p "Do you want to build and push new Docker image? [y/N]: " build_choice
    
    if [[ "$build_choice" =~ ^[Yy]$ ]]; then
        log_info "Building Docker image..."
        
        cd "$PROJECT_ROOT"
        
        IMAGE_NAME="gcr.io/polylynx/strategy-trade-poly:$NEW_IMAGE_TAG"
        
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

backup_database() {
    echo ""
    read -p "Do you want to backup database before upgrade? [Y/n]: " backup_choice
    
    if [[ ! "$backup_choice" =~ ^[Nn]$ ]]; then
        log_info "Creating database backup..."
        
        POSTGRES_POD=$(kubectl get pods -n "$NAMESPACE" -l app=postgresql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
        
        if [ -z "$POSTGRES_POD" ]; then
            log_warning "PostgreSQL pod not found, skipping backup"
            return
        fi
        
        BACKUP_FILE="backup_$(date +%Y%m%d_%H%M%S).sql"
        
        kubectl exec -n "$NAMESPACE" "$POSTGRES_POD" -- \
            pg_dump -U polymarket polymarket_db > "/tmp/$BACKUP_FILE"
        
        if [ $? -eq 0 ]; then
            log_success "Database backup created: /tmp/$BACKUP_FILE"
            BACKUP_DB=true
        else
            log_error "Failed to create database backup"
            read -p "Continue without backup? [y/N]: " continue_choice
            if [[ ! "$continue_choice" =~ ^[Yy]$ ]]; then
                exit 1
            fi
        fi
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

refresh_gcr_secret() {
    log_info "Refreshing GCR authentication secret..."
    
    # Check if gcloud is available
    if ! command -v gcloud &> /dev/null; then
        log_warning "gcloud not found, skipping secret refresh"
        return 0
    fi
    
    # Get fresh token
    TOKEN=$(gcloud auth print-access-token 2>/dev/null)
    
    if [ -z "$TOKEN" ]; then
        log_warning "Could not get gcloud token, skipping secret refresh"
        return 0
    fi
    
    # Delete and recreate secret
    kubectl delete secret gcr-json-key -n "$NAMESPACE" 2>/dev/null || true
    kubectl create secret docker-registry gcr-json-key \
        --docker-server=gcr.io \
        --docker-username=oauth2accesstoken \
        --docker-password="$TOKEN" \
        --docker-email=duyphan9696@gmail.com \
        -n "$NAMESPACE" &> /dev/null
    
    if [ $? -eq 0 ]; then
        log_success "GCR secret refreshed"
    else
        log_warning "Failed to refresh GCR secret, continuing anyway..."
    fi
}

dry_run_upgrade() {
    echo ""
    read -p "Run dry-run before actual upgrade? [Y/n]: " dryrun_choice
    
    if [[ ! "$dryrun_choice" =~ ^[Nn]$ ]]; then
        log_info "Running dry-run upgrade..."
        
        helm upgrade "$RELEASE_NAME" "$CHART_PATH" \
            -f "$VALUES_FILE" \
            --set app.image.tag="$NEW_IMAGE_TAG" \
            --namespace "$NAMESPACE" \
            --dry-run --debug
        
        echo ""
        read -p "Does the dry-run output look correct? [Y/n]: " proceed
        
        if [[ "$proceed" =~ ^[Nn]$ ]]; then
            log_warning "Upgrade cancelled by user"
            exit 0
        fi
    fi
}

configure_auto_rollback() {
    echo ""
    read -p "Enable auto-rollback on failure? [Y/n]: " rollback_choice
    
    if [[ ! "$rollback_choice" =~ ^[Nn]$ ]]; then
        AUTO_ROLLBACK=true
        log_success "Auto-rollback enabled"
    fi
}

upgrade_application() {
    log_info "Upgrading application..."
    echo ""
    
    UPGRADE_CMD="helm upgrade $RELEASE_NAME $CHART_PATH \
        -f $VALUES_FILE \
        --set app.image.tag=$NEW_IMAGE_TAG \
        --namespace $NAMESPACE \
        --wait \
        --timeout $TIMEOUT"
    
    if [ "$AUTO_ROLLBACK" = true ]; then
        UPGRADE_CMD="$UPGRADE_CMD --cleanup-on-fail"
    fi
    
    # Execute upgrade
    eval "$UPGRADE_CMD"
    
    UPGRADE_STATUS=$?
    
    if [ $UPGRADE_STATUS -eq 0 ]; then
        log_success "Upgrade successful!"
    else
        log_error "Upgrade failed!"
        
        if [ "$AUTO_ROLLBACK" = false ]; then
            echo ""
            read -p "Do you want to rollback? [Y/n]: " manual_rollback
            
            if [[ ! "$manual_rollback" =~ ^[Nn]$ ]]; then
                log_info "Rolling back..."
                helm rollback "$RELEASE_NAME" -n "$NAMESPACE" --wait
                
                if [ $? -eq 0 ]; then
                    log_success "Rollback successful"
                else
                    log_error "Rollback failed!"
                fi
            fi
        fi
        
        exit 1
    fi
}

verify_upgrade() {
    log_info "Verifying upgrade..."
    echo ""
    
    # Wait a bit for pods to stabilize
    sleep 5
    
    # Check pod status
    log_info "Pod status:"
    kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME"
    
    # Get new image
    NEW_RUNNING_IMAGE=$(kubectl get deployment -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" -o jsonpath='{.items[0].spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")
    log_info "Running image: $NEW_RUNNING_IMAGE"
    
    # Check if all pods are ready
    READY_PODS=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" -o jsonpath='{range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' 2>/dev/null | grep -c "True" || echo "0")
    TOTAL_PODS=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" --no-headers 2>/dev/null | wc -l | tr -d ' ')
    
    echo ""
    if [ "$READY_PODS" -eq "$TOTAL_PODS" ]; then
        log_success "All pods are ready ($READY_PODS/$TOTAL_PODS)"
    else
        log_warning "Some pods are not ready ($READY_PODS/$TOTAL_PODS)"
    fi
    
    # Show revision history
    echo ""
    log_info "Deployment history:"
    helm history "$RELEASE_NAME" -n "$NAMESPACE" --max 5
}

show_logs() {
    echo ""
    read -p "Do you want to view application logs? [y/N]: " logs_choice
    
    if [[ "$logs_choice" =~ ^[Yy]$ ]]; then
        log_info "Showing logs (Press Ctrl+C to exit)..."
        kubectl logs -n "$NAMESPACE" -l app.kubernetes.io/name=strategy-trade-poly --tail=50 -f
    fi
}

health_check() {
    echo ""
    log_info "Running health check..."
    
    # Port forward and check health endpoint
    log_info "Testing health endpoint..."
    
    kubectl port-forward -n "$NAMESPACE" svc/strategy-trade-poly 3000:3000 &
    PF_PID=$!
    
    sleep 3
    
    HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health || echo "000")
    
    kill $PF_PID 2>/dev/null || true
    
    if [ "$HEALTH_STATUS" = "200" ]; then
        log_success "Health check passed (HTTP $HEALTH_STATUS)"
    else
        log_warning "Health check returned HTTP $HEALTH_STATUS"
    fi
}

show_useful_commands() {
    echo ""
    log_info "Useful commands:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  View logs:       kubectl logs -n $NAMESPACE -l app.kubernetes.io/name=strategy-trade-poly --tail=100 -f"
    echo "  Get pods:        kubectl get pods -n $NAMESPACE -l app.kubernetes.io/instance=$RELEASE_NAME"
    echo "  Port forward:    kubectl port-forward -n $NAMESPACE svc/strategy-trade-poly 3000:3000"
    echo "  Rollback:        helm rollback $RELEASE_NAME -n $NAMESPACE"
    echo "  History:         helm history $RELEASE_NAME -n $NAMESPACE"
    echo "  Status:          helm status $RELEASE_NAME -n $NAMESPACE"
}

# Main execution
main() {
    print_banner
    
    check_prerequisites
    
    check_release_exists
    
    show_current_status
    
    get_current_image
    
    select_environment
    
    get_new_image_tag
    
    refresh_gcr_secret
    
    build_and_push_image
    
    backup_database
    
    validate_chart
    
    dry_run_upgrade
    
    configure_auto_rollback
    
    upgrade_application
    
    verify_upgrade
    
    health_check
    
    show_useful_commands
    
    show_logs
    
    echo ""
    log_success "Upgrade completed successfully! 🚀"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--namespace)
            NAMESPACE="$2"
            shift 2
            ;;
        -t|--tag)
            NEW_IMAGE_TAG="$2"
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
        --auto-rollback)
            AUTO_ROLLBACK=true
            shift
            ;;
        --no-backup)
            BACKUP_DB=false
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -n, --namespace NAME       Kubernetes namespace (default: default)"
            echo "  -t, --tag TAG             New Docker image tag"
            echo "  -e, --environment ENV     Environment: dev, staging, production"
            echo "  --auto-rollback           Enable automatic rollback on failure"
            echo "  --no-backup               Skip database backup"
            echo "  -h, --help                Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                                    # Interactive mode"
            echo "  $0 -e production -t v1.1.0           # Upgrade production"
            echo "  $0 -t v1.2.0 --auto-rollback         # Upgrade with auto-rollback"
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

