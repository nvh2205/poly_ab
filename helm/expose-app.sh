#!/bin/bash

#############################################
# Expose App Script
# Exposes the app with LoadBalancer and shows the external IP
#############################################

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
RELEASE_NAME="strategy-trade-poly"
NAMESPACE="default"

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
    echo "║   Strategy Trade Poly - Expose App       ║"
    echo "╚═══════════════════════════════════════════╝"
    echo -e "${NC}"
}

get_external_ip() {
    log_info "Checking service status..."
    
    SERVICE_NAME="$RELEASE_NAME-service"
    SERVICE_TYPE=$(kubectl get svc "$SERVICE_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.type}' 2>/dev/null || echo "")
    
    if [ -z "$SERVICE_TYPE" ]; then
        log_error "Service '$SERVICE_NAME' not found in namespace '$NAMESPACE'"
        exit 1
    fi
    
    log_info "Service type: $SERVICE_TYPE"
    
    if [ "$SERVICE_TYPE" != "LoadBalancer" ]; then
        log_warning "Service is not of type LoadBalancer"
        log_info "Current service type: $SERVICE_TYPE"
        echo ""
        log_info "To expose the app, you need to upgrade with LoadBalancer type"
        log_info "Run: helm upgrade $RELEASE_NAME ./strategy-trade-poly -n $NAMESPACE --reuse-values --set app.service.type=LoadBalancer"
        exit 1
    fi
    
    log_info "Waiting for external IP to be assigned..."
    echo ""
    
    # Wait for external IP (max 5 minutes)
    SECONDS=0
    MAX_WAIT=300
    
    while [ $SECONDS -lt $MAX_WAIT ]; do
        EXTERNAL_IP=$(kubectl get svc "$SERVICE_NAME" -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
        
        if [ -n "$EXTERNAL_IP" ] && [ "$EXTERNAL_IP" != "<pending>" ]; then
            log_success "External IP assigned!"
            echo ""
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo -e "${GREEN}🌐 Access your app at:${NC}"
            echo ""
            echo -e "   ${BLUE}http://$EXTERNAL_IP${NC}"
            echo ""
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            log_info "Available endpoints:"
            echo "  • Health Check:  http://$EXTERNAL_IP/health"
            echo "  • API Docs:      http://$EXTERNAL_IP/api"
            echo ""
            
            # Show service details
            echo ""
            log_info "Service details:"
            kubectl get svc "$SERVICE_NAME" -n "$NAMESPACE"
            
            return 0
        fi
        
        echo -n "."
        sleep 5
        SECONDS=$((SECONDS + 5))
    done
    
    echo ""
    log_error "Timeout waiting for external IP"
    log_info "Check service status with: kubectl get svc $SERVICE_NAME -n $NAMESPACE"
    exit 1
}

show_current_services() {
    echo ""
    log_info "Current services in namespace '$NAMESPACE':"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    kubectl get svc -n "$NAMESPACE" -l app.kubernetes.io/instance="$RELEASE_NAME"
}

update_security() {
    echo ""
    log_warning "Security Notice:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Your app is now publicly accessible."
    echo ""
    echo "To restrict access to specific IPs, update values.yaml:"
    echo ""
    echo "  app:"
    echo "    service:"
    echo "      loadBalancerSourceRanges:"
    echo "        - \"YOUR_IP/32\"  # Replace with your IP"
    echo ""
    echo "Then run: helm upgrade $RELEASE_NAME ./strategy-trade-poly -n $NAMESPACE -f values.yaml"
    echo ""
}

# Main execution
print_banner
show_current_services
get_external_ip
update_security

log_success "Done!"










