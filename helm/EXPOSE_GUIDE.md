# Hướng dẫn Expose App ra Internet

## 🚀 Phương pháp 1: LoadBalancer (Đơn giản, nhanh)

### Bước 1: Cập nhật deployment hiện tại

```bash
cd helm
helm upgrade strategy-trade-poly ./strategy-trade-poly -n default \
  --set app.service.type=LoadBalancer \
  --set app.service.port=80
```

### Bước 2: Lấy External IP

```bash
# Chạy script tự động
./expose-app.sh

# Hoặc kiểm tra thủ công
kubectl get svc strategy-trade-poly-service -n default
```

### Bước 3: Truy cập ứng dụng

Sau khi có External IP (ví dụ: `34.123.45.67`):

```bash
# Health check
curl http://34.123.45.67/health

# API documentation
open http://34.123.45.67/api

# API endpoints
curl http://34.123.45.67/api/markets
```

## 🔒 Tăng cường bảo mật

### Giới hạn truy cập theo IP

Chỉnh sửa `values.yaml`:

```yaml
app:
  service:
    type: LoadBalancer
    port: 80
    targetPort: 3000
    loadBalancerSourceRanges:
      - "YOUR_IP/32"        # Thay bằng IP của bạn
      - "113.23.55.126/32"  # IP khác nếu cần
```

Sau đó upgrade:

```bash
helm upgrade strategy-trade-poly ./strategy-trade-poly -n default -f values.yaml
```

### Kiểm tra IP hiện tại của bạn

```bash
curl ifconfig.me
# Hoặc
curl ipinfo.io/ip
```

## 🌐 Phương pháp 2: Ingress với Static IP (Chuyên nghiệp hơn)

### Bước 1: Tạo Static IP trên GCP

```bash
# Tạo static IP
gcloud compute addresses create strategy-trade-poly-ip \
  --global \
  --ip-version IPV4

# Lấy địa chỉ IP
gcloud compute addresses describe strategy-trade-poly-ip --global
```

### Bước 2: Cập nhật values.yaml

```yaml
app:
  service:
    type: ClusterIP  # Giữ ClusterIP khi dùng Ingress
    port: 3000
    targetPort: 3000
  
  ingress:
    enabled: true
    className: "gce"
    annotations:
      kubernetes.io/ingress.global-static-ip-name: "strategy-trade-poly-ip"
      networking.gke.io/managed-certificates: "strategy-trade-poly-cert"
    hosts:
      - host: api.yourdomain.com  # Thay bằng domain của bạn
        paths:
          - path: /
            pathType: Prefix
```

### Bước 3: Deploy với Ingress

```bash
helm upgrade strategy-trade-poly ./strategy-trade-poly -n default -f values.yaml
```

### Bước 4: Kiểm tra Ingress

```bash
kubectl get ingress -n default
kubectl describe ingress strategy-trade-poly-ingress -n default
```

## 📊 Kiểm tra trạng thái

### Xem tất cả services

```bash
kubectl get svc -n default
```

### Xem logs của app

```bash
kubectl logs -f deployment/strategy-trade-poly -n default
```

### Xem events

```bash
kubectl get events -n default --sort-by='.lastTimestamp'
```

## 🔧 Troubleshooting

### External IP pending quá lâu

```bash
# Kiểm tra service
kubectl describe svc strategy-trade-poly-service -n default

# Kiểm tra quotas của GCP
gcloud compute project-info describe --project=polylynx
```

### Không truy cập được

```bash
# Kiểm tra pods đang chạy
kubectl get pods -n default

# Kiểm tra logs
kubectl logs -f <pod-name> -n default

# Kiểm tra health endpoint từ trong pod
kubectl exec -it <pod-name> -n default -- curl localhost:3000/health
```

### Reset về ClusterIP

```bash
helm upgrade strategy-trade-poly ./strategy-trade-poly -n default \
  --set app.service.type=ClusterIP \
  --set app.service.port=3000
```

## 💡 Best Practices

1. **Sử dụng HTTPS**: Setup SSL certificate cho production
2. **Giới hạn IP**: Luôn giới hạn truy cập theo IP trong môi trường production
3. **Monitoring**: Setup monitoring và alerting
4. **Rate Limiting**: Thêm rate limiting để tránh abuse
5. **Authentication**: Thêm API authentication/authorization

## 📝 Ghi chú

- **LoadBalancer** tốn phí hàng tháng (~$10-20/tháng trên GCP)
- **Static IP** cũng tốn phí nếu không sử dụng
- Nên sử dụng **Ingress** cho production với nhiều services
- **ClusterIP** là lựa chọn tốt nhất cho internal services










