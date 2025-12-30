# Quick Reference - GKE Deployment

## 🚀 Quick Start Commands

### Deploy mới
```bash
cd helm
./deploy.sh
```

### Upgrade
```bash
cd helm
./upgrade.sh
```

### Rollback
```bash
cd helm
./rollback.sh
```

### Kiểm tra status
```bash
cd helm
./status.sh
```

---

## 📝 Common Tasks

### 1. Deploy lần đầu (Production)

```bash
# 1. Chuẩn bị values file
cd helm
cp strategy-trade-poly/values.production.example.yaml values.production.yaml
# Edit values.production.yaml với thông tin thực tế

# 2. Build và push image
cd ..
docker build -t gcr.io/polylynx/strategy-trade-poly:v1.0.0 .
docker push gcr.io/polylynx/strategy-trade-poly:v1.0.0

# 3. Deploy
cd helm
./deploy.sh
# Chọn: 3 (Production), nhập tag: v1.0.0
```

### 2. Update code và deploy version mới

```bash
# 1. Build image mới
docker build -t gcr.io/polylynx/strategy-trade-poly:v1.1.0 .
docker push gcr.io/polylynx/strategy-trade-poly:v1.1.0

# 2. Upgrade
cd helm
./upgrade.sh
# Nhập tag mới: v1.1.0
```

### 3. Rollback khi có lỗi

```bash
cd helm
./rollback.sh
# Chọn revision muốn rollback
```

### 4. Kiểm tra trạng thái

```bash
cd helm
./status.sh
```

---

## 🔧 Manual Commands

### Helm Commands

```bash
# List releases
helm list -n default

# Get release status
helm status strategy-trade-poly -n default

# View history
helm history strategy-trade-poly -n default

# Upgrade (manual)
helm upgrade strategy-trade-poly strategy-trade-poly/ \
  -f values.production.yaml \
  --set app.image.tag=v1.1.0 \
  --wait

# Rollback
helm rollback strategy-trade-poly -n default

# Uninstall
helm uninstall strategy-trade-poly -n default
```

### Kubectl Commands

```bash
# Get pods
kubectl get pods -l app.kubernetes.io/instance=strategy-trade-poly

# Get all resources
kubectl get all -l app.kubernetes.io/instance=strategy-trade-poly

# View logs
kubectl logs -l app.kubernetes.io/name=strategy-trade-poly --tail=100 -f

# Describe pod
kubectl describe pod <pod-name>

# Exec into pod
kubectl exec -it <pod-name> -- /bin/sh

# Port forward
kubectl port-forward svc/strategy-trade-poly 3000:3000

# Scale deployment
kubectl scale deployment strategy-trade-poly --replicas=3

# Restart deployment
kubectl rollout restart deployment strategy-trade-poly

# Check rollout status
kubectl rollout status deployment strategy-trade-poly

# View events
kubectl get events --sort-by='.lastTimestamp'
```

### Docker Commands

```bash
# Build image
docker build -t gcr.io/polylynx/strategy-trade-poly:v1.0.0 .

# Push to GCR
docker push gcr.io/polylynx/strategy-trade-poly:v1.0.0

# List images
docker images | grep strategy-trade-poly

# Remove local image
docker rmi gcr.io/polylynx/strategy-trade-poly:v1.0.0
```

### GCloud Commands

```bash
# List clusters
gcloud container clusters list

# Get credentials
gcloud container clusters get-credentials cluster-1 --region us-central1

# List GCR images
gcloud container images list --repository=gcr.io/polylynx

# List image tags
gcloud container images list-tags gcr.io/polylynx/strategy-trade-poly

# Delete image
gcloud container images delete gcr.io/polylynx/strategy-trade-poly:v1.0.0
```

---

## 🐛 Debugging

### Pod không start

```bash
# 1. Xem describe pod
kubectl describe pod <pod-name>

# 2. Xem logs
kubectl logs <pod-name>

# 3. Xem events
kubectl get events --field-selector involvedObject.name=<pod-name>

# 4. Check image pull
kubectl get events | grep -i "pull"
```

### Database connection issues

```bash
# 1. Check PostgreSQL pod
kubectl get pods -l app=postgresql
kubectl logs -l app=postgresql

# 2. Test connection từ app pod
kubectl exec -it <app-pod> -- nc -zv postgresql-service 5432

# 3. Port forward và test local
kubectl port-forward svc/postgresql-service 5432:5432
psql -h localhost -U polymarket -d polymarket_db
```

### Redis connection issues

```bash
# 1. Check Redis pod
kubectl get pods -l app=redis
kubectl logs -l app=redis

# 2. Test connection
kubectl exec -it <app-pod> -- nc -zv redis-service 6379

# 3. Port forward và test
kubectl port-forward svc/redis-service 6379:6379
redis-cli -h localhost
```

### Out of resources

```bash
# Check node resources
kubectl describe nodes
kubectl top nodes

# Check pod resources
kubectl top pods

# Scale down nếu cần
kubectl scale deployment strategy-trade-poly --replicas=1
```

### Xem logs chi tiết

```bash
# Logs của app
kubectl logs -l app.kubernetes.io/name=strategy-trade-poly --tail=100 -f

# Logs của tất cả containers trong pod
kubectl logs <pod-name> --all-containers=true

# Logs của container cụ thể
kubectl logs <pod-name> -c <container-name>

# Logs của previous container (nếu crashed)
kubectl logs <pod-name> --previous
```

---

## 📊 Monitoring

### Check resource usage

```bash
# Top pods
kubectl top pods -n default

# Top nodes
kubectl top nodes

# Describe deployment
kubectl describe deployment strategy-trade-poly
```

### Health checks

```bash
# Check endpoints
kubectl get endpoints

# Test health từ bên ngoài
kubectl port-forward svc/strategy-trade-poly 3000:3000
curl http://localhost:3000/health

# Test từ trong pod
kubectl exec -it <pod-name> -- wget -q -O- http://localhost:3000/health
```

---

## 💾 Backup & Restore

### Backup Database

```bash
# Get PostgreSQL pod name
POSTGRES_POD=$(kubectl get pods -l app=postgresql -o jsonpath='{.items[0].metadata.name}')

# Backup
kubectl exec $POSTGRES_POD -- pg_dump -U polymarket polymarket_db > backup_$(date +%Y%m%d_%H%M%S).sql

# Backup to pod then copy
kubectl exec $POSTGRES_POD -- pg_dump -U polymarket polymarket_db > /tmp/backup.sql
kubectl cp $POSTGRES_POD:/tmp/backup.sql ./backup.sql
```

### Restore Database

```bash
# Restore từ file local
kubectl exec -i $POSTGRES_POD -- psql -U polymarket polymarket_db < backup.sql

# Copy file vào pod rồi restore
kubectl cp ./backup.sql $POSTGRES_POD:/tmp/backup.sql
kubectl exec $POSTGRES_POD -- psql -U polymarket polymarket_db < /tmp/backup.sql
```

---

## 🔐 Secrets Management

### Create secrets

```bash
# Docker registry secret
kubectl create secret docker-registry gcr-json-key \
  --docker-server=gcr.io \
  --docker-username=_json_key \
  --docker-password="$(cat gcr-key.json)" \
  --docker-email=your-email@example.com

# Generic secret
kubectl create secret generic app-secrets \
  --from-literal=db-password=YOUR_PASSWORD \
  --from-literal=redis-password=YOUR_PASSWORD
```

### View secrets

```bash
# List secrets
kubectl get secrets

# Describe secret
kubectl describe secret <secret-name>

# Get secret value (base64 encoded)
kubectl get secret <secret-name> -o jsonpath='{.data.password}' | base64 -d
```

---

## 📈 Scaling

### Manual scaling

```bash
# Scale up
kubectl scale deployment strategy-trade-poly --replicas=5

# Scale down
kubectl scale deployment strategy-trade-poly --replicas=1
```

### Auto-scaling (HPA)

```bash
# Create HPA
kubectl autoscale deployment strategy-trade-poly \
  --cpu-percent=70 \
  --min=2 \
  --max=10

# View HPA
kubectl get hpa

# Delete HPA
kubectl delete hpa strategy-trade-poly
```

---

## 🔄 CI/CD Integration

### Simple CI/CD script

```bash
#!/bin/bash
# deploy-ci.sh

VERSION=$1
ENVIRONMENT=${2:-production}

# Build
docker build -t gcr.io/polylynx/strategy-trade-poly:$VERSION .

# Push
docker push gcr.io/polylynx/strategy-trade-poly:$VERSION

# Deploy/Upgrade
cd helm
if helm status strategy-trade-poly -n default &> /dev/null; then
  # Upgrade
  helm upgrade strategy-trade-poly strategy-trade-poly/ \
    -f values.$ENVIRONMENT.yaml \
    --set app.image.tag=$VERSION \
    --wait --timeout 10m
else
  # Install
  helm install strategy-trade-poly strategy-trade-poly/ \
    -f values.$ENVIRONMENT.yaml \
    --set app.image.tag=$VERSION \
    --wait --timeout 10m
fi
```

Usage:
```bash
chmod +x deploy-ci.sh
./deploy-ci.sh v1.2.0 production
```

---

## 📞 Emergency Procedures

### Application down

```bash
# 1. Check pods
kubectl get pods -l app.kubernetes.io/instance=strategy-trade-poly

# 2. Check logs
kubectl logs -l app.kubernetes.io/name=strategy-trade-poly --tail=100

# 3. Restart deployment
kubectl rollout restart deployment strategy-trade-poly

# 4. If still down, rollback
helm rollback strategy-trade-poly
```

### Database issues

```bash
# 1. Check PostgreSQL
kubectl get pods -l app=postgresql
kubectl logs -l app=postgresql

# 2. Restart PostgreSQL
kubectl rollout restart deployment postgresql

# 3. Check PVC
kubectl get pvc
kubectl describe pvc postgresql-data-pvc
```

### Complete restart

```bash
# Restart everything
kubectl rollout restart deployment -l app.kubernetes.io/instance=strategy-trade-poly

# Or delete pods (they will recreate)
kubectl delete pods -l app.kubernetes.io/instance=strategy-trade-poly
```

---

## 📚 Additional Resources

- [Helm Documentation](https://helm.sh/docs/)
- [Kubernetes Documentation](https://kubernetes.io/docs/)
- [Google Kubernetes Engine](https://cloud.google.com/kubernetes-engine/docs)
- [Full Deployment Guide](./DEPLOYMENT_GUIDE.md)










