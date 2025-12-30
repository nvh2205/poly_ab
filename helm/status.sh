#!/bin/bash

#############################################
# Status Check Script for Strategy Trade Poly
# Check deployment status and health
#############################################

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default values
RELEASE_NAME="strategy-trade-poly"
NAMESPACE="default"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

print_banner() {
    echo -e "${CYAN}"
    echo "╔═══════════════════════════════════════════╗"
    echo "║    Strategy Trade Poly - Status Check    ║"
    echo "╚═══════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_section() {
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}$1${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

check_prerequisites() {
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
}

check_release_status() {
    print_section "HELM RELEASE STATUS"
    
    if helm status "$RELEASE_NAME" -n "$NAMESPACE" &> /dev/null; then
        log_success "Release '$RELEASE_NAME' exists"
        echo ""
        helm status "$RELEASE_NAME" -n "$NAMESPACE"
    else
        log_error "Release '$RELEASE_NAME' not found in namespace '$NAMESPACE'"
        exit 1
    fi
}

check_deployment_history() {
    print_section "DEPLOYMENT HISTORY"
    
    helm history "$RELEASE_NAME" -n "$NAMESPACE" --max 10
}

check_pods() {
    print_section "PODS STATUS"
    
    kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" -o wide
    
    echo ""
    
    # Count pod status
    RUNNING_PODS=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" -o jsonpath='{range .items[*]}{.status.phase}{"\n"}{end}' | grep -c "Running" || echo "0")
    TOTAL_PODS=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" --no-headers | wc -l | tr -d ' ')
    READY_PODS=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" -o jsonpath='{range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' | grep -c "True" || echo "0")
    
    if [ "$READY_PODS" -eq "$TOTAL_PODS" ] && [ "$TOTAL_PODS" -gt 0 ]; then
        log_success "All pods are running and ready ($READY_PODS/$TOTAL_PODS)"
    elif [ "$TOTAL_PODS" -eq 0 ]; then
        log_error "No pods found"
    else
        log_warning "Some pods are not ready ($READY_PODS/$TOTAL_PODS running: $RUNNING_PODS)"
    fi
}

check_services() {
    print_section "SERVICES"
    
    kubectl get services -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" -o wide
}

check_ingress() {
    print_section "INGRESS"
    
    if kubectl get ingress -n "$NAMESPACE" strategy-trade-poly-ingress &> /dev/null; then
        kubectl get ingress -n "$NAMESPACE" strategy-trade-poly-ingress
    else
        log_info "No ingress configured"
    fi
}

check_pvc() {
    print_section "PERSISTENT VOLUMES"
    
    kubectl get pvc -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME"
}

check_resources() {
    print_section "RESOURCE USAGE"
    
    if kubectl top pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME" &> /dev/null; then
        kubectl top pods -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME"
    else
        log_warning "Metrics server not available or not enough metrics"
    fi
}

check_image_versions() {
    print_section "IMAGE VERSIONS"
    
    # App image
    APP_IMAGE=$(kubectl get deployment -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME",app.kubernetes.io/component!=database,app.kubernetes.io/component!=cache -o jsonpath='{.items[0].spec.template.spec.containers[0].image}' 2>/dev/null)
    if [ -n "$APP_IMAGE" ]; then
        echo "Application: $APP_IMAGE"
    fi
    
    # PostgreSQL image
    PG_IMAGE=$(kubectl get deployment -n "$NAMESPACE" -l app=postgresql -o jsonpath='{.items[0].spec.template.spec.containers[0].image}' 2>/dev/null)
    if [ -n "$PG_IMAGE" ]; then
        echo "PostgreSQL:  $PG_IMAGE"
    fi
    
    # Redis image
    REDIS_IMAGE=$(kubectl get deployment -n "$NAMESPACE" -l app=redis -o jsonpath='{.items[0].spec.template.spec.containers[0].image}' 2>/dev/null)
    if [ -n "$REDIS_IMAGE" ]; then
        echo "Redis:       $REDIS_IMAGE"
    fi
}

check_recent_events() {
    print_section "RECENT EVENTS"
    
    kubectl get events -n "$NAMESPACE" \
        --field-selector involvedObject.kind=Pod \
        --sort-by='.lastTimestamp' \
        | tail -20
}

check_health_endpoint() {
    print_section "HEALTH CHECK"
    
    # Try to get a pod
    POD_NAME=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=strategy-trade-poly -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    
    if [ -z "$POD_NAME" ]; then
        log_error "No app pods found"
        return
    fi
    
    log_info "Testing health endpoint on pod: $POD_NAME"
    
    HEALTH_RESPONSE=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -- wget -q -O- http://localhost:3000/health 2>/dev/null || echo "FAILED")
    
    if [ "$HEALTH_RESPONSE" != "FAILED" ]; then
        log_success "Health endpoint is responding"
        echo "$HEALTH_RESPONSE"
    else
        log_error "Health endpoint not responding"
    fi
}

show_logs_tail() {
    print_section "RECENT LOGS (Last 20 lines)"
    
    kubectl logs -n "$NAMESPACE" -l app.kubernetes.io/name=strategy-trade-poly --tail=20 --prefix=true 2>/dev/null || log_info "No logs available"
}

show_quick_actions() {
    print_section "QUICK ACTIONS"
    
    echo "View live logs:"
    echo "  kubectl logs -n $NAMESPACE -l app.kubernetes.io/name=strategy-trade-poly --tail=100 -f"
    echo ""
    echo "Port forward to local:"
    echo "  kubectl port-forward -n $NAMESPACE svc/strategy-trade-poly 3000:3000"
    echo ""
    echo "Exec into pod:"
    POD_NAME=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=strategy-trade-poly -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    if [ -n "$POD_NAME" ]; then
        echo "  kubectl exec -it -n $NAMESPACE $POD_NAME -- /bin/sh"
    fi
    echo ""
    echo "Scale deployment:"
    echo "  kubectl scale deployment -n $NAMESPACE strategy-trade-poly --replicas=3"
    echo ""
    echo "Restart deployment:"
    echo "  kubectl rollout restart deployment -n $NAMESPACE strategy-trade-poly"
    echo ""
    echo "View detailed pod info:"
    if [ -n "$POD_NAME" ]; then
        echo "  kubectl describe pod -n $NAMESPACE $POD_NAME"
    fi
}

# Main execution
main() {
    print_banner
    
    check_prerequisites
    
    check_release_status
    
    check_deployment_history
    
    check_pods
    
    check_services
    
    check_ingress
    
    check_pvc
    
    check_image_versions
    
    check_resources
    
    check_health_endpoint
    
    check_recent_events
    
    show_logs_tail
    
    show_quick_actions
    
    echo ""
    log_success "Status check completed!"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--namespace)
            NAMESPACE="$2"
            shift 2
            ;;
        -r|--release)
            RELEASE_NAME="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -n, --namespace NAME       Kubernetes namespace (default: default)"
            echo "  -r, --release NAME         Helm release name (default: strategy-trade-poly)"
            echo "  -h, --help                Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                         # Check default release"
            echo "  $0 -n staging              # Check staging namespace"
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

