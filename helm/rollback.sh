#!/bin/bash

#############################################
# Rollback Script for Strategy Trade Poly
# Rollback to previous deployment version
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

# Default values
RELEASE_NAME="strategy-trade-poly"
NAMESPACE="default"
TIMEOUT="5m"

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
    echo -e "${YELLOW}"
    echo "╔═══════════════════════════════════════════╗"
    echo "║  Strategy Trade Poly - Rollback Script   ║"
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
        exit 1
    fi
    
    log_success "Release found"
}

show_deployment_history() {
    echo ""
    log_info "Deployment history:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    helm history "$RELEASE_NAME" -n "$NAMESPACE"
}

get_current_revision() {
    CURRENT_REVISION=$(helm history "$RELEASE_NAME" -n "$NAMESPACE" -o json | jq -r '.[-1].revision')
    log_info "Current revision: $CURRENT_REVISION"
}

select_revision() {
    echo ""
    
    if [ -n "$TARGET_REVISION" ]; then
        log_info "Using specified revision: $TARGET_REVISION"
        return
    fi
    
    read -p "Enter revision number to rollback to (or press Enter for previous): " TARGET_REVISION
    
    if [ -z "$TARGET_REVISION" ]; then
        TARGET_REVISION=$((CURRENT_REVISION - 1))
        log_info "Rolling back to previous revision: $TARGET_REVISION"
    fi
    
    # Validate revision exists
    if ! helm history "$RELEASE_NAME" -n "$NAMESPACE" -o json | jq -e ".[] | select(.revision == $TARGET_REVISION)" &> /dev/null; then
        log_error "Revision $TARGET_REVISION not found"
        exit 1
    fi
}

show_revision_details() {
    echo ""
    log_info "Revision $TARGET_REVISION details:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    REVISION_INFO=$(helm history "$RELEASE_NAME" -n "$NAMESPACE" -o json | jq ".[] | select(.revision == $TARGET_REVISION)")
    
    echo "$REVISION_INFO" | jq -r '"Status: \(.status)\nDescription: \(.description)\nUpdated: \(.updated)"'
}

confirm_rollback() {
    echo ""
    log_warning "⚠️  You are about to rollback from revision $CURRENT_REVISION to revision $TARGET_REVISION"
    echo ""
    read -p "Are you sure you want to proceed? [y/N]: " confirm
    
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        log_info "Rollback cancelled"
        exit 0
    fi
}

perform_rollback() {
    log_info "Performing rollback..."
    echo ""
    
    helm rollback "$RELEASE_NAME" "$TARGET_REVISION" \
        -n "$NAMESPACE" \
        --wait \
        --timeout "$TIMEOUT"
    
    if [ $? -eq 0 ]; then
        log_success "Rollback successful!"
    else
        log_error "Rollback failed!"
        exit 1
    fi
}

verify_rollback() {
    log_info "Verifying rollback..."
    echo ""
    
    # Wait for pods to stabilize
    sleep 5
    
    # Check pod status
    log_info "Pod status:"
    kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME"
    
    # Check if all pods are ready
    READY_PODS=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" -o jsonpath='{range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' | grep -c "True")
    TOTAL_PODS=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" --no-headers | wc -l)
    
    echo ""
    if [ "$READY_PODS" -eq "$TOTAL_PODS" ]; then
        log_success "All pods are ready ($READY_PODS/$TOTAL_PODS)"
    else
        log_warning "Some pods are not ready ($READY_PODS/$TOTAL_PODS)"
        
        echo ""
        log_info "Pod details:"
        kubectl describe pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME"
    fi
    
    # Show current revision
    NEW_REVISION=$(helm history "$RELEASE_NAME" -n "$NAMESPACE" -o json | jq -r '.[-1].revision')
    log_info "New revision: $NEW_REVISION"
}

show_logs() {
    echo ""
    read -p "Do you want to view application logs? [y/N]: " logs_choice
    
    if [[ "$logs_choice" =~ ^[Yy]$ ]]; then
        log_info "Showing logs (Press Ctrl+C to exit)..."
        kubectl logs -n "$NAMESPACE" -l app.kubernetes.io/name=strategy-trade-poly --tail=100 -f
    fi
}

health_check() {
    echo ""
    log_info "Running health check..."
    
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

show_summary() {
    echo ""
    log_info "Rollback Summary:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Release:         $RELEASE_NAME"
    echo "  Namespace:       $NAMESPACE"
    echo "  From Revision:   $CURRENT_REVISION"
    echo "  To Revision:     $TARGET_REVISION"
    echo ""
    
    log_info "Current deployment history:"
    helm history "$RELEASE_NAME" -n "$NAMESPACE" --max 5
}

show_useful_commands() {
    echo ""
    log_info "Useful commands:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  View logs:       kubectl logs -n $NAMESPACE -l app.kubernetes.io/name=strategy-trade-poly --tail=100 -f"
    echo "  Get pods:        kubectl get pods -n $NAMESPACE -l app.kubernetes.io/instance=$RELEASE_NAME"
    echo "  Port forward:    kubectl port-forward -n $NAMESPACE svc/strategy-trade-poly 3000:3000"
    echo "  History:         helm history $RELEASE_NAME -n $NAMESPACE"
    echo "  Status:          helm status $RELEASE_NAME -n $NAMESPACE"
}

# Main execution
main() {
    print_banner
    
    check_prerequisites
    
    check_release_exists
    
    show_deployment_history
    
    get_current_revision
    
    select_revision
    
    show_revision_details
    
    confirm_rollback
    
    perform_rollback
    
    verify_rollback
    
    health_check
    
    show_summary
    
    show_useful_commands
    
    show_logs
    
    echo ""
    log_success "Rollback completed successfully! ↩️"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--namespace)
            NAMESPACE="$2"
            shift 2
            ;;
        -r|--revision)
            TARGET_REVISION="$2"
            shift 2
            ;;
        --timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -n, --namespace NAME       Kubernetes namespace (default: default)"
            echo "  -r, --revision NUMBER      Target revision to rollback to"
            echo "  --timeout DURATION         Timeout for rollback (default: 5m)"
            echo "  -h, --help                Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                         # Interactive mode"
            echo "  $0 -r 3                    # Rollback to revision 3"
            echo "  $0 -n staging -r 2         # Rollback staging to revision 2"
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










