# Strategy Trade Poly - Helm Deployment

Thư mục này chứa Helm charts và scripts để deploy ứng dụng Strategy Trade Poly lên Google Kubernetes Engine (GKE).

## 📁 Cấu trúc thư mục

```
helm/
├── README.md                           # File này
├── DEPLOYMENT_GUIDE.md                 # Hướng dẫn chi tiết
├── QUICK_REFERENCE.md                  # Tham khảo nhanh commands
├── deploy.sh                           # Script deploy mới
├── upgrade.sh                          # Script upgrade
├── rollback.sh                         # Script rollback
├── status.sh                           # Script kiểm tra status
├── values.production.yaml              # Production values (tạo từ example)
└── strategy-trade-poly/                # Helm chart
    ├── Chart.yaml                      # Chart metadata
    ├── values.yaml                     # Default values
    ├── values.production.example.yaml  # Production template
    ├── values.small-nodes.yaml         # Small nodes config
    └── templates/                      # Kubernetes templates
        ├── deployment.yaml
        ├── service.yaml
        ├── ingress.yaml
        ├── configmap.yaml
        ├── secret.yaml
        ├── postgres/
        └── redis/
```

## 🚀 Quick Start

### 1. Setup ban đầu

```bash
# Make scripts executable
chmod +x *.sh

# Tạo production values file
cp strategy-trade-poly/values.production.example.yaml values.production.yaml

# Chỉnh sửa values.production.yaml với thông tin thực tế
vim values.production.yaml
```

### 2. Deploy lần đầu

```bash
./deploy.sh
```

### 3. Upgrade version mới

```bash
./upgrade.sh
```

### 4. Kiểm tra status

```bash
./status.sh
```

### 5. Rollback nếu cần

```bash
./rollback.sh
```

## 📚 Tài liệu

### Hướng dẫn chi tiết
Xem [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) cho:
- Yêu cầu và setup ban đầu
- Hướng dẫn deploy từng bước
- Upgrade và rollback
- Troubleshooting
- Best practices

### Tham khảo nhanh
Xem [QUICK_REFERENCE.md](./QUICK_REFERENCE.md) cho:
- Commands thường dùng
- Debugging tips
- Backup/restore procedures
- Emergency procedures

## 🔧 Scripts

### deploy.sh
Deploy ứng dụng lần đầu hoặc reinstall

**Features:**
- Interactive mode với menu chọn
- Auto validate chart
- Dry-run option
- Build và push Docker image
- Watch pods status

**Usage:**
```bash
# Interactive mode
./deploy.sh

# With arguments
./deploy.sh -e production -t v1.0.0
./deploy.sh -n staging -t latest --dry-run
```

### upgrade.sh
Upgrade ứng dụng đã deploy

**Features:**
- Show current status và history
- Database backup option
- Auto-rollback on failure
- Health check sau upgrade
- Zero-downtime deployment

**Usage:**
```bash
# Interactive mode
./upgrade.sh

# With arguments
./upgrade.sh -e production -t v1.1.0
./upgrade.sh -t v1.2.0 --auto-rollback
```

### rollback.sh
Rollback về version trước

**Features:**
- Show deployment history
- Select revision để rollback
- Verify sau rollback
- Health check
- View logs option

**Usage:**
```bash
# Interactive mode
./rollback.sh

# Rollback to specific revision
./rollback.sh -r 3
./rollback.sh -n staging -r 2
```

### status.sh
Kiểm tra trạng thái deployment

**Features:**
- Helm release status
- Pods, services, ingress status
- Resource usage
- Recent events
- Health check
- Quick action commands

**Usage:**
```bash
# Default namespace
./status.sh

# Specific namespace
./status.sh -n staging
```

## ⚙️ Configuration

### values.yaml
Default configuration cho development

### values.production.yaml
Production configuration (cần tạo từ example)

**Cần cập nhật:**
- Image tag (specific version, không dùng `latest`)
- Domain names
- Database passwords
- Redis passwords
- Resource limits
- Replica count
- Storage sizes

### values.small-nodes.yaml
Configuration cho cluster với nodes nhỏ (reduced resources)

## 🏗️ Architecture

Helm chart này deploy:

1. **Application** (NestJS)
   - Deployment với configurable replicas
   - Service (ClusterIP)
   - Ingress (optional)
   - ConfigMap cho environment variables
   - Secrets cho sensitive data

2. **PostgreSQL**
   - Deployment với persistent storage
   - Service (LoadBalancer or ClusterIP)
   - PVC cho data persistence
   - ConfigMap cho initialization

3. **Redis**
   - Deployment với persistent storage
   - Service (ClusterIP)
   - PVC cho data persistence
   - Appendonly mode enabled

## 🔐 Security

### Secrets Management

Secrets không được commit vào git. Tạo secrets manually:

```bash
# Database passwords
kubectl create secret generic db-secrets \
  --from-literal=postgres-password=YOUR_PASSWORD \
  --from-literal=db-password=YOUR_PASSWORD

# Redis password (nếu enabled)
kubectl create secret generic redis-secrets \
  --from-literal=password=YOUR_PASSWORD

# Image pull secret (nếu cần)
kubectl create secret docker-registry gcr-json-key \
  --docker-server=gcr.io \
  --docker-username=_json_key \
  --docker-password="$(cat gcr-key.json)" \
  --docker-email=your-email@example.com
```

### Best Practices

1. ✅ Sử dụng specific image tags trong production
2. ✅ Enable authentication cho Redis trong production
3. ✅ Sử dụng strong passwords
4. ✅ Whitelist IPs cho PostgreSQL LoadBalancer
5. ✅ Regular backups
6. ✅ Monitor resource usage
7. ✅ Test trên staging trước production

## 📊 Monitoring

### Logs

```bash
# Application logs
kubectl logs -l app.kubernetes.io/name=strategy-trade-poly --tail=100 -f

# PostgreSQL logs
kubectl logs -l app=postgresql --tail=100 -f

# Redis logs
kubectl logs -l app=redis --tail=100 -f
```

### Metrics

```bash
# Pod resource usage
kubectl top pods

# Node resource usage
kubectl top nodes
```

### Health Check

```bash
# Port forward và test
kubectl port-forward svc/strategy-trade-poly 3000:3000
curl http://localhost:3000/health
```

## 🔄 CI/CD Integration

### GitHub Actions Example

```yaml
name: Deploy to GKE

on:
  push:
    tags:
      - 'v*'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      
      - name: Setup Cloud SDK
        uses: google-github-actions/setup-gcloud@v0
        with:
          service_account_key: ${{ secrets.GCP_SA_KEY }}
          project_id: polylynx
      
      - name: Configure Docker
        run: gcloud auth configure-docker
      
      - name: Build and Push
        run: |
          VERSION=${GITHUB_REF#refs/tags/}
          docker build -t gcr.io/polylynx/strategy-trade-poly:$VERSION .
          docker push gcr.io/polylynx/strategy-trade-poly:$VERSION
      
      - name: Deploy
        run: |
          gcloud container clusters get-credentials cluster-1 --region us-central1
          cd helm
          ./upgrade.sh -t $VERSION -e production --auto-rollback
```

## 🆘 Support

### Common Issues

1. **Pods not starting**: Check `kubectl describe pod <pod-name>`
2. **Image pull errors**: Verify GCR credentials
3. **Database connection**: Check service names và passwords
4. **Out of resources**: Scale down hoặc increase node resources

### Useful Commands

```bash
# Quick status check
./status.sh

# View all resources
kubectl get all -l app.kubernetes.io/instance=strategy-trade-poly

# Describe deployment
kubectl describe deployment strategy-trade-poly

# Get events
kubectl get events --sort-by='.lastTimestamp'
```

## 📞 Contact

- Team: PolyLynx
- Project: Strategy Trade Poly
- Docs: [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)

---

## Version History

- **1.0.0** - Initial Helm chart with PostgreSQL and Redis
- Scripts for deploy, upgrade, rollback, and status check










