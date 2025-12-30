# Hướng dẫn Upgrade Ứng dụng

## 🚀 Upgrade với Script Tự động

### Cách sử dụng đơn giản:

```bash
cd helm
./upgrade.sh
```

Script sẽ hỏi bạn:
1. **Environment**: Dev / Staging / Production
2. **Image tag**: Nhập tag mới (ví dụ: `v1.2.0`)
3. **Dry-run**: Có chạy thử trước không?
4. **Auto-rollback**: Tự động rollback nếu thất bại?

### Tính năng của script:

✅ **Tự động refresh GCR secret** - Đảm bảo có thể pull image
✅ **Validate chart** - Kiểm tra cấu hình trước khi upgrade
✅ **Dry-run option** - Xem trước thay đổi
✅ **Auto-rollback** - Tự động rollback nếu thất bại
✅ **Health check** - Kiểm tra pods sau upgrade
✅ **Hiển thị logs** - Xem logs nếu có lỗi

## 🔧 Cải thiện đã thực hiện

### 1. **Tăng Timeout**
- **Trước:** 10 phút
- **Sau:** 15 phút
- **Lý do:** Đủ thời gian cho image pull và pod startup

### 2. **Deployment Strategy**
- **Trước:** `Recreate` (terminate pod cũ trước, sau đó tạo pod mới)
- **Sau:** `RollingUpdate` (tạo pod mới trước, sau đó terminate pod cũ)
- **Lợi ích:** 
  - Không downtime
  - Nhanh hơn
  - An toàn hơn

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1        # Cho phép 1 pod thêm trong quá trình upgrade
    maxUnavailable: 0  # Luôn có ít nhất 1 pod running
```

### 3. **Auto-refresh GCR Secret**
- Tự động làm mới OAuth token trước mỗi upgrade
- Tránh lỗi `ImagePullBackOff` do token hết hạn

### 4. **Xóa duplicate flags**
- Đã xóa `--wait --timeout` bị duplicate
- Giữ lại `--cleanup-on-fail` khi enable auto-rollback

## 📝 Upgrade thủ công

### Cách 1: Sử dụng Helm trực tiếp

```bash
# 1. Refresh GCR secret trước
./refresh-gcr-secret.sh

# 2. Upgrade với Helm
helm upgrade strategy-trade-poly ./strategy-trade-poly \
  -n default \
  --set app.image.tag=v1.2.0 \
  --wait \
  --timeout=15m \
  --cleanup-on-fail

# 3. Kiểm tra status
kubectl get pods -n default
```

### Cách 2: Upgrade từ values file

```bash
# 1. Sửa values.yaml
vim strategy-trade-poly/values.yaml
# Thay đổi: app.image.tag: "v1.2.0"

# 2. Refresh secret
./refresh-gcr-secret.sh

# 3. Upgrade
helm upgrade strategy-trade-poly ./strategy-trade-poly \
  -n default \
  -f strategy-trade-poly/values.yaml \
  --wait \
  --timeout=15m
```

## 🔄 Rollback nếu có vấn đề

### Rollback nhanh

```bash
# Rollback về revision trước đó
helm rollback strategy-trade-poly -n default

# Rollback về revision cụ thể
helm rollback strategy-trade-poly 8 -n default

# Xem history để chọn revision
helm history strategy-trade-poly -n default
```

### Sử dụng script rollback

```bash
./rollback.sh
```

## 🔍 Troubleshooting

### Lỗi: ImagePullBackOff

**Nguyên nhân:** GCR secret đã hết hạn

**Giải pháp:**
```bash
# Refresh secret
./refresh-gcr-secret.sh

# Hoặc thủ công
TOKEN=$(gcloud auth print-access-token)
kubectl delete secret gcr-json-key -n default
kubectl create secret docker-registry gcr-json-key \
  --docker-server=gcr.io \
  --docker-username=oauth2accesstoken \
  --docker-password="$TOKEN" \
  --docker-email=duyphan9696@gmail.com \
  -n default

# Delete pod để recreate
kubectl delete pod -n default -l app=strategy-trade-poly
```

### Lỗi: Timeout waiting for deployment

**Nguyên nhân:** 
- Image quá lớn, pull chậm
- Application startup chậm
- Health check fail

**Giải pháp:**

1. **Kiểm tra pod status:**
```bash
kubectl get pods -n default -l app=strategy-trade-poly
kubectl describe pod <pod-name> -n default
```

2. **Xem logs:**
```bash
kubectl logs -n default -l app=strategy-trade-poly --tail=100
```

3. **Tăng timeout:**
```bash
# Trong upgrade.sh, sửa dòng 25:
TIMEOUT="20m"  # Tăng lên 20 phút
```

4. **Kiểm tra health endpoint:**
```bash
kubectl port-forward -n default <pod-name> 3000:3000
curl http://localhost:3000/health
```

### Lỗi: Deployment stuck in "InProgress"

**Giải pháp:**

```bash
# 1. Kiểm tra current revision
helm history strategy-trade-poly -n default

# 2. Nếu status là "pending-upgrade", rollback
helm rollback strategy-trade-poly -n default

# 3. Hoặc force delete deployment và recreate
kubectl delete deployment strategy-trade-poly -n default
helm upgrade strategy-trade-poly ./strategy-trade-poly -n default --install
```

### Lỗi: CrashLoopBackOff

**Nguyên nhân:** Application lỗi khi startup

**Giải pháp:**

```bash
# 1. Xem logs
kubectl logs -n default <pod-name> --previous

# 2. Kiểm tra config
kubectl get configmap strategy-trade-poly-config -n default -o yaml
kubectl get secret strategy-trade-poly-secrets -n default -o yaml

# 3. Rollback về version cũ
helm rollback strategy-trade-poly -n default
```

## 📊 Kiểm tra sau Upgrade

### Checklist:

- [ ] Pods đang running
- [ ] Health check OK
- [ ] Application logs không có error
- [ ] API endpoints hoạt động
- [ ] Database connection OK
- [ ] Redis connection OK

### Commands:

```bash
# 1. Check pods
kubectl get pods -n default

# 2. Check health
curl http://<EXTERNAL-IP>/health

# 3. Check logs
kubectl logs -n default -l app=strategy-trade-poly --tail=50

# 4. Check deployment
kubectl get deployment strategy-trade-poly -n default

# 5. Check services
kubectl get svc -n default

# 6. Test API
curl http://<EXTERNAL-IP>/
curl http://<EXTERNAL-IP>/market/active-tokens
```

## 💡 Best Practices

1. **Luôn refresh GCR secret trước khi upgrade**
2. **Chạy dry-run trước để xem trước thay đổi**
3. **Enable auto-rollback cho production**
4. **Backup database trước upgrade quan trọng**
5. **Test trong dev/staging trước khi upgrade production**
6. **Monitor logs trong quá trình upgrade**
7. **Có kế hoạch rollback sẵn sàng**
8. **Document mỗi lần upgrade (image tag, changes, issues)**

## 🔐 Giải pháp lâu dài cho GCR Authentication

OAuth tokens chỉ có hiệu lực 1 giờ. Để tránh phải refresh thường xuyên:

### Option 1: Sử dụng Service Account Key

```bash
# 1. Tạo service account key
gcloud iam service-accounts keys create ~/gcr-key.json \
  --iam-account=<service-account>@polylynx.iam.gserviceaccount.com

# 2. Tạo secret từ key
kubectl delete secret gcr-json-key -n default
kubectl create secret docker-registry gcr-json-key \
  --docker-server=gcr.io \
  --docker-username=_json_key \
  --docker-password="$(cat ~/gcr-key.json)" \
  --docker-email=duyphan9696@gmail.com \
  -n default

# 3. Xóa key file
rm ~/gcr-key.json
```

### Option 2: Sử dụng Workload Identity (Recommended)

```bash
# Configure Workload Identity for GKE
# https://cloud.google.com/kubernetes-engine/docs/how-to/workload-identity
```

## 📚 Tài liệu liên quan

- [Helm Upgrade Documentation](https://helm.sh/docs/helm/helm_upgrade/)
- [Kubernetes Deployment Strategies](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#strategy)
- [GCR Authentication](https://cloud.google.com/container-registry/docs/advanced-authentication)

