#!/bin/bash

#############################################
# Test Image Script
# Tests a Docker image before upgrading
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
TEST_POD_NAME="test-image-pod"

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
    echo "║   Test Docker Image                       ║"
    echo "╚═══════════════════════════════════════════╝"
    echo -e "${NC}"
}

cleanup() {
    if kubectl get pod "$TEST_POD_NAME" -n "$NAMESPACE" &> /dev/null; then
        log_info "Cleaning up test pod..."
        kubectl delete pod "$TEST_POD_NAME" -n "$NAMESPACE" &> /dev/null || true
    fi
}

get_image_tag() {
    echo ""
    log_info "Enter image tag to test (e.g., v1.2.0):"
    read -p "Tag: " IMAGE_TAG
    
    if [ -z "$IMAGE_TAG" ]; then
        log_error "Image tag cannot be empty"
        exit 1
    fi
    
    IMAGE="gcr.io/polylynx/strategy-trade-poly:$IMAGE_TAG"
    log_info "Testing image: $IMAGE"
}

test_image() {
    log_info "Creating test pod..."
    
    # Cleanup any existing test pod
    cleanup
    
    # Create test pod with same config as deployment using YAML
    cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: $TEST_POD_NAME
  namespace: $NAMESPACE
spec:
  imagePullSecrets:
  - name: gcr-json-key
  containers:
  - name: test-container
    image: $IMAGE
    imagePullPolicy: Always
    env:
    - name: NODE_ENV
      value: "production"
    - name: PORT
      value: "3000"
    command: ["sleep"]
    args: ["30"]
  restartPolicy: Never
EOF
    
    if [ $? -ne 0 ]; then
        log_error "Failed to create test pod"
        exit 1
    fi
    
    log_success "Test pod created"
    
    # Wait for pod to be scheduled
    log_info "Waiting for pod to start..."
    sleep 3
    
    # Check pod status
    POD_STATUS=$(kubectl get pod "$TEST_POD_NAME" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
    
    echo ""
    log_info "Checking pod status for 30 seconds..."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # Monitor pod for 30 seconds
    for i in {1..30}; do
        POD_STATUS=$(kubectl get pod "$TEST_POD_NAME" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
        CONTAINER_STATE=$(kubectl get pod "$TEST_POD_NAME" -n "$NAMESPACE" -o jsonpath='{.status.containerStatuses[0].state}' 2>/dev/null || echo "{}")
        
        echo -n "[$i/30] Status: $POD_STATUS "
        
        # Check for specific states
        if echo "$CONTAINER_STATE" | grep -q "running"; then
            echo -e "${GREEN}✓${NC}"
            SUCCESS=true
            break
        elif echo "$CONTAINER_STATE" | grep -q "waiting"; then
            REASON=$(echo "$CONTAINER_STATE" | grep -o '"reason":"[^"]*"' | cut -d'"' -f4)
            echo -e "${YELLOW}Waiting: $REASON${NC}"
            
            if [ "$REASON" = "ImagePullBackOff" ] || [ "$REASON" = "ErrImagePull" ]; then
                log_error "Image pull failed!"
                break
            elif [ "$REASON" = "CrashLoopBackOff" ]; then
                log_error "Container is crashing!"
                break
            fi
        elif echo "$CONTAINER_STATE" | grep -q "terminated"; then
            REASON=$(echo "$CONTAINER_STATE" | grep -o '"reason":"[^"]*"' | cut -d'"' -f4)
            EXIT_CODE=$(echo "$CONTAINER_STATE" | grep -o '"exitCode":[0-9]*' | cut -d':' -f2)
            echo -e "${RED}Terminated: $REASON (exit code: $EXIT_CODE)${NC}"
            break
        else
            echo ""
        fi
        
        sleep 1
    done
    
    echo ""
}

show_results() {
    echo ""
    log_info "Test Results:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # Get final status
    kubectl get pod "$TEST_POD_NAME" -n "$NAMESPACE"
    
    echo ""
    log_info "Pod events:"
    kubectl get events -n "$NAMESPACE" \
        --field-selector involvedObject.name="$TEST_POD_NAME" \
        --sort-by='.lastTimestamp' | tail -10
    
    echo ""
    log_info "Container logs:"
    kubectl logs "$TEST_POD_NAME" -n "$NAMESPACE" 2>&1 | head -20
    
    # Check for common errors
    LOGS=$(kubectl logs "$TEST_POD_NAME" -n "$NAMESPACE" 2>&1)
    
    echo ""
    if echo "$LOGS" | grep -q "exec format error"; then
        log_error "❌ EXEC FORMAT ERROR detected!"
        echo ""
        echo "This means the image was built for the wrong architecture."
        echo ""
        echo "Solution:"
        echo "  1. Rebuild with: docker build --platform linux/amd64 ..."
        echo "  2. Or add to Dockerfile: FROM --platform=linux/amd64 node:..."
        echo ""
        RESULT="FAILED"
    elif echo "$LOGS" | grep -qi "error\|fatal\|exception"; then
        log_error "❌ Application errors detected in logs"
        RESULT="FAILED"
    elif kubectl get pod "$TEST_POD_NAME" -n "$NAMESPACE" -o jsonpath='{.status.containerStatuses[0].state.running}' &> /dev/null; then
        log_success "✅ Image test PASSED!"
        echo ""
        echo "The image appears to be working correctly."
        echo "You can proceed with the upgrade."
        RESULT="PASSED"
    else
        log_warning "⚠️  Image test INCONCLUSIVE"
        echo ""
        echo "The pod didn't reach running state, but no critical errors detected."
        echo "Please review the logs above before upgrading."
        RESULT="INCONCLUSIVE"
    fi
}

# Main execution
trap cleanup EXIT

print_banner
get_image_tag
test_image
show_results

echo ""
if [ "$RESULT" = "PASSED" ]; then
    log_success "Ready to upgrade!"
    echo ""
    echo "Run: ./upgrade.sh"
elif [ "$RESULT" = "FAILED" ]; then
    log_error "DO NOT upgrade with this image!"
    echo ""
    echo "Fix the image first, then test again."
    exit 1
else
    log_warning "Review results before upgrading"
    exit 0
fi

