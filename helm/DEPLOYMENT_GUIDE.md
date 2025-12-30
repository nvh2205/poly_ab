# Hướng Dẫn Deploy và Upgrade App lên GKE

## 📋 Mục lục

1. [Yêu cầu](#yêu-cầu)
2. [Cấu hình ban đầu](#cấu-hình-ban-đầu)
3. [Deploy lần đầu](#deploy-lần-đầu)
4. [Upgrade ứng dụng](#upgrade-ứng-dụng)
5. [Rollback](#rollback)
6. [Kiểm tra và Debug](#kiểm-tra-và-debug)
7. [Xóa deployment](#xóa-deployment)

---

## 🔧 Yêu cầu

### 1. Tools cần cài đặt

```bash
# Google Cloud SDK
gcloud --version

# Kubectl
kubectl version --client

# Helm 3+
helm version

# Docker (để build images)
docker --version
```

### 2. Setup GCloud

```bash
# Login vào Google Cloud
gcloud auth login

# Set project
gcloud config set project polylynx

# Cấu hình Docker với GCR
gcloud auth configure-docker

# Connect tới GKE cluster
gcloud container clusters get-credentials cluster-1 --region us-central1
```

### 3. Kiểm tra kết nối

```bash
# Kiểm tra cluster
kubectl cluster-info

# List nodes
kubectl get nodes

# List namespaces
kubectl get namespaces
```

---

## ⚙️ Cấu hình ban đầu

### 1. Tạo file values cho production

Tạo file `values.production.yaml` từ template:

```bash
cd helm
cp strategy-trade-poly/values.production.example.yaml values.production.yaml
```

### 2. Cập nhật thông tin trong `values.production.yaml`

```yaml
global:
  projectId: polylynx
  region: us-central1
  clusterName: "cluster-1"

app:
  replicaCount: 3  # Số lượng pods
  
  image:
    repository: gcr.io/polylynx/strategy-trade-poly
    tag: "v1.0.0"  # Version cụ thể
  
  ingress:
    enabled: true
    hosts:
      - host: api.yourdomain.com  # Domain của bạn

postgresql:
  auth:
    postgresPassword: "YOUR_STRONG_PASSWORD"
    password: "YOUR_DB_PASSWORD"
  
  persistence:
    size: 100Gi

redis:
  auth:
    enabled: true
    password: "YOUR_REDIS_PASSWORD"
  
  persistence:
    size: 50Gi
```

### 3. Tạo Image Pull Secret (nếu cần)

```bash
# Nếu sử dụng private GCR registry
kubectl create secret docker-registry gcr-json-key \
  --docker-server=gcr.io \
  --docker-username=_json_key \
  --docker-password="$(cat ~/path/to/gcr-key.json)" \
  --docker-email=your-email@example.com \
  --namespace=default
```

---

## 🚀 Deploy lần đầu

### Cách 1: Sử dụng script tự động

```bash
# Từ thư mục helm
./deploy.sh
```

Script sẽ hỏi các thông tin:
- Environment (dev/staging/production)
- Image tag
- Namespace

### Cách 2: Deploy thủ công

#### Bước 1: Build và push Docker image

```bash
# Từ thư mục root của project
docker build -t gcr.io/polylynx/strategy-trade-poly:v1.0.0 .
docker push gcr.io/polylynx/strategy-trade-poly:v1.0.0
```

#### Bước 2: Validate Helm chart

```bash
cd helm

# Kiểm tra syntax
helm lint strategy-trade-poly/

# Dry-run để xem output
helm install strategy-trade-poly strategy-trade-poly/ \
  -f values.production.yaml \
  --dry-run --debug
```

#### Bước 3: Deploy

```bash
# Deploy với production values
helm install strategy-trade-poly strategy-trade-poly/ \
  -f values.production.yaml \
  --namespace default \
  --create-namespace
```

#### Bước 4: Kiểm tra deployment

```bash
# Xem status
helm status strategy-trade-poly

# Xem pods
kubectl get pods -l app.kubernetes.io/name=strategy-trade-poly

# Xem logs
kubectl logs -l app.kubernetes.io/name=strategy-trade-poly --tail=100 -f

# Xem services
kubectl get services
```

---

## 🔄 Upgrade ứng dụng

### Cách 1: Sử dụng script tự động

```bash
# Từ thư mục helm
./upgrade.sh
```

Script sẽ hỏi:
- Image tag mới
- Có muốn backup không
- Có muốn rollback tự động nếu fail không

### Cách 2: Upgrade thủ công

#### Bước 1: Build image mới

```bash
# Build với tag mới
docker build -t gcr.io/polylynx/strategy-trade-poly:v1.1.0 .
docker push gcr.io/polylynx/strategy-trade-poly:v1.1.0
```

#### Bước 2: Update values file (tùy chọn)

```yaml
# values.production.yaml
app:
  image:
    tag: "v1.1.0"  # Update version
```

#### Bước 3: Upgrade Helm release

```bash
cd helm

# Dry-run trước
helm upgrade strategy-trade-poly strategy-trade-poly/ \
  -f values.production.yaml \
  --dry-run --debug

# Upgrade thực tế
helm upgrade strategy-trade-poly strategy-trade-poly/ \
  -f values.production.yaml \
  --namespace default \
  --wait \
  --timeout 5m
```

#### Bước 4: Kiểm tra sau upgrade

```bash
# Xem history
helm history strategy-trade-poly

# Xem pods mới
kubectl get pods -l app.kubernetes.io/name=strategy-trade-poly -w

# Check logs
kubectl logs -l app.kubernetes.io/name=strategy-trade-poly --tail=50

# Test health endpoint
kubectl port-forward svc/strategy-trade-poly 3000:3000
curl http://localhost:3000/health
```

### Upgrade chỉ thay đổi image tag (nhanh)

```bash
# Upgrade chỉ image tag
helm upgrade strategy-trade-poly strategy-trade-poly/ \
  --reuse-values \
  --set app.image.tag=v1.1.0 \
  --wait
```

### Upgrade với zero-downtime

```bash
# Set rolling update strategy trong values.yaml
app:
  replicaCount: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0

# Upgrade
helm upgrade strategy-trade-poly strategy-trade-poly/ \
  -f values.production.yaml \
  --wait
```

---

## ⏪ Rollback

### Xem lịch sử deployments

```bash
helm history strategy-trade-poly
```

### Rollback tới version trước

```bash
# Rollback tới revision trước đó
helm rollback strategy-trade-poly

# Rollback tới revision cụ thể
helm rollback strategy-trade-poly 2

# Rollback với timeout
helm rollback strategy-trade-poly --wait --timeout 5m
```

### Rollback sử dụng script

```bash
./rollback.sh
```

---

## 🔍 Kiểm tra và Debug

### Xem logs

```bash
# Logs của app
kubectl logs -l app.kubernetes.io/name=strategy-trade-poly --tail=100 -f

# Logs của PostgreSQL
kubectl logs -l app=postgresql --tail=100 -f

# Logs của Redis
kubectl logs -l app=redis --tail=100 -f

# Logs của pod cụ thể
kubectl logs <pod-name> --tail=100 -f
```

### Kiểm tra resources

```bash
# Xem tất cả resources
kubectl get all -l app.kubernetes.io/instance=strategy-trade-poly

# Xem pods với details
kubectl get pods -o wide

# Describe pod
kubectl describe pod <pod-name>

# Xem events
kubectl get events --sort-by='.lastTimestamp'
```

### Debug pod

```bash
# Exec vào container
kubectl exec -it <pod-name> -- /bin/sh

# Port forward để test local
kubectl port-forward svc/strategy-trade-poly 3000:3000

# Port forward PostgreSQL
kubectl port-forward svc/postgresql-service 5432:5432

# Port forward Redis
kubectl port-forward svc/redis-service 6379:6379
```

### Kiểm tra health

```bash
# Health check
kubectl get pods -l app.kubernetes.io/name=strategy-trade-poly

# Check readiness
kubectl get pods -o json | jq '.items[].status.conditions'

# Test endpoints
kubectl run curl-test --image=curlimages/curl --rm -it --restart=Never -- \
  curl http://strategy-trade-poly:3000/health
```

### Xem metrics và resource usage

```bash
# CPU và Memory usage
kubectl top pods -l app.kubernetes.io/name=strategy-trade-poly

# Node resources
kubectl top nodes

# Describe resource limits
kubectl describe pod <pod-name> | grep -A 5 "Limits\|Requests"
```

---

## 🗑️ Xóa deployment

### Xóa Helm release (giữ lại data)

```bash
# Uninstall nhưng giữ history
helm uninstall strategy-trade-poly --keep-history

# Uninstall hoàn toàn
helm uninstall strategy-trade-poly
```

### Xóa PVC (data)

```bash
# List PVCs
kubectl get pvc

# Xóa PVC của PostgreSQL (⚠️ DATA SẼ MẤT)
kubectl delete pvc postgresql-data-pvc

# Xóa PVC của Redis (⚠️ DATA SẼ MẤT)
kubectl delete pvc redis-data-pvc
```

### Xóa toàn bộ

```bash
# Xóa tất cả resources
helm uninstall strategy-trade-poly
kubectl delete pvc -l app.kubernetes.io/instance=strategy-trade-poly
kubectl delete secret gcr-json-key
```

---

## 📊 Monitoring và Best Practices

### 1. Monitoring

```bash
# Theo dõi deployment progress
kubectl rollout status deployment/strategy-trade-poly

# Xem history của deployment
kubectl rollout history deployment/strategy-trade-poly

# Pause deployment
kubectl rollout pause deployment/strategy-trade-poly

# Resume deployment
kubectl rollout resume deployment/strategy-trade-poly
```

### 2. Best Practices

#### Production Checklist

- [ ] Sử dụng specific image tags (không dùng `latest`)
- [ ] Set resource limits và requests
- [ ] Enable health checks (liveness + readiness)
- [ ] Sử dụng multiple replicas (≥ 3)
- [ ] Enable persistent storage cho database
- [ ] Backup database thường xuyên
- [ ] Sử dụng secrets cho sensitive data
- [ ] Enable logging và monitoring
- [ ] Test trên staging trước khi deploy production
- [ ] Document các thay đổi

#### Backup Database

```bash
# Backup PostgreSQL
kubectl exec -it <postgres-pod> -- pg_dump -U polymarket polymarket_db > backup.sql

# Restore
kubectl exec -i <postgres-pod> -- psql -U polymarket polymarket_db < backup.sql
```

### 3. Troubleshooting thường gặp

#### Pods không start

```bash
# Kiểm tra events
kubectl describe pod <pod-name>

# Kiểm tra logs
kubectl logs <pod-name>

# Kiểm tra image pull
kubectl get events | grep -i pull
```

#### Database connection issues

```bash
# Test kết nối từ app pod
kubectl exec -it <app-pod> -- nc -zv postgresql-service 5432

# Check PostgreSQL logs
kubectl logs -l app=postgresql
```

#### Out of resources

```bash
# Check node resources
kubectl describe nodes

# Check pod resources
kubectl top pods

# Scale down if needed
kubectl scale deployment strategy-trade-poly --replicas=1
```

---

## 📞 Support

Nếu gặp vấn đề, kiểm tra:
1. Logs của pods
2. Events trong namespace
3. Resource usage (CPU, Memory)
4. Network connectivity
5. Image pull status

Contact: PolyLynx Team










