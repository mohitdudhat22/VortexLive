# Live Streaming Platform - High-Level Design (HLD)

## 1. Overview

This document describes the **High-Level Design** for a scalable live-streaming platform that ingests media from browsers and mobile clients, processes streams in real-time, and forwards them to multiple RTMP/RTMPS destinations (YouTube, Twitch, Facebook) while simultaneously delivering adaptive bitrate (ABR) streams to viewers via CDN.

### 1.1 Key Capabilities

- **Multi-source Ingestion**: WebRTC from browsers, native streaming from mobile apps
- **Multi-destination Forwarding**: Simultaneous publishing to YouTube Live, Twitch, Facebook Live via RTMP/RTMPS
- **Adaptive Bitrate Delivery**: HLS/LL-HLS/DASH for viewers with automatic quality switching
- **Real-time Transcoding**: GPU/CPU worker pools for efficient multi-bitrate encoding
- **VOD Archive**: Automatic recording to object storage (S3-compatible)
- **High Availability**: Automatic failover, process restart policies, health monitoring
- **Observability**: Comprehensive metrics (Prometheus), centralized logging (ELK)

### 1.2 Design Goals

- **Low Latency**: < 3s glass-to-glass for live viewers (LL-HLS)
- **High Throughput**: Support 10,000+ concurrent streams per datacenter
- **Reliability**: 99.9% uptime with automatic recovery from transient failures
- **Scalability**: Horizontal scaling of all components
- **Security**: Token-based authentication, rate limiting, input sanitization

---

## 2. System Architecture

### 2.1 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           CLIENTS                                    │
│  ┌──────────────┐              ┌──────────────┐                    │
│  │   Browser    │              │  Mobile App  │                    │
│  │ (WebRTC/WS)  │              │ (Native WS)  │                    │
│  └──────┬───────┘              └──────┬───────┘                    │
└─────────┼──────────────────────────────┼──────────────────────────┘
          │                              │
          └──────────────┬───────────────┘
                         │
          ┌──────────────▼──────────────┐
          │   GATEWAY & SIGNALING       │
          │   Socket.IO / WebSocket     │
          │   (Auth, Rate Limit)        │
          └──────────────┬──────────────┘
                         │
          ┌──────────────▼──────────────┐
          │     INGEST MANAGER          │
          │  - Per-room buffers         │
          │  - EBML header store        │
          │  - Backpressure control     │
          └──┬───────────────────────┬──┘
             │                       │
             │                       └──────────────┐
             │                                      │
   ┌─────────▼─────────┐                  ┌────────▼────────┐
   │  FFMPEG ADAPTER   │                  │  TRANSCODING    │
   │  (Multi-Process)  │                  │      FARM       │
   │                   │                  │  (GPU/CPU Pool) │
   │ ┌───┐ ┌───┐ ┌───┐│                  └────────┬────────┘
   │ │YT │ │TW │ │FB ││                           │
   │ └─┬─┘ └─┬─┘ └─┬─┘│                           │
   └───┼─────┼─────┼───┘                  ┌────────▼────────┐
       │     │     │                      │   PACKAGER      │
       │     │     │                      │  (HLS/DASH)     │
       │     │     │                      └────────┬────────┘
       │     │     │                               │
   ┌───▼─────▼─────▼───┐                  ┌────────▼────────┐
   │  EXTERNAL RTMP    │                  │   CDN / EDGE    │
   │   TARGETS         │                  │   (Viewers)     │
   │ YouTube│Twitch│FB │                  └─────────────────┘
   └───────────────────┘
             │
   ┌─────────▼─────────┐
   │   ORCHESTRATOR    │
   │  & CONTROL PLANE  │
   │  - Stream keys    │
   │  - Destinations   │
   │  - Lifecycle mgmt │
   └─────────┬─────────┘
             │
   ┌─────────▼─────────┐
   │  MONITORING &     │
   │    STORAGE        │
   │ Prometheus│ELK│S3 │
   └───────────────────┘
```

### 2.2 Component Overview

| Component | Responsibility | Technology Stack |
|-----------|---------------|------------------|
| **Gateway** | WebSocket connections, auth, rate limiting | Node.js + Socket.IO / Go + Gorilla WebSocket |
| **Ingest Manager** | Buffer management, header extraction, backpressure | Node.js / Go with ring buffers |
| **FFmpeg Adapter** | Process spawning, stdin writing, health monitoring | Node.js child_process / Go exec |
| **Transcoding Farm** | Multi-bitrate encoding (1080p/720p/480p/360p) | FFmpeg on GPU workers (NVIDIA T4) |
| **Packager** | HLS/LL-HLS/DASH segment generation | FFmpeg / Shaka Packager / MediaPackage |
| **CDN/Edge** | Content delivery to viewers | CloudFront / Cloudflare / Fastly |
| **Orchestrator** | Stream lifecycle, destination management | Node.js / Go with Redis state store |
| **Storage** | VOD archives, segment storage | S3 / GCS / MinIO |
| **Monitoring** | Metrics, logs, alerting | Prometheus + Grafana, ELK Stack |

---

## 3. Data Flow

### 3.1 Stream Ingestion Flow

1. **Client Connection**
   - Browser/mobile client connects to Gateway via WebSocket
   - Auth middleware validates JWT token (5-min expiry)
   - Rate limiter checks: max 3 streams per client per minute

2. **Stream Initialization**
   - Client sends `start-stream` event with streamKey and destination list
   - Ingest Manager allocates per-room ring buffer (256 slots, 100MB max)
   - Orchestrator registers stream and maps destinations

3. **EBML Header Handling**
   - First chunk identified as WebM/EBML header (magic bytes: 0x1A45DFA3)
   - Header stored in in-memory cache (Redis or local Map)
   - Header required to initialize all FFmpeg processes

4. **FFmpeg Process Spawning**
   - One child process per destination (YouTube, Twitch, Facebook)
   - Command: `ffmpeg -re -i pipe:0 -c copy -f flv rtmp://target/key`
   - Header written to stdin before any data chunks
   - `wroteHeader` flag set to prevent re-seeding

5. **Chunk Distribution**
   - Data chunks enqueued to ring buffer
   - Distributed to all active FFmpeg processes via stdin
   - Backpressure: if `write()` returns false, pause client until `drain` event

6. **RTMP Forwarding**
   - Each FFmpeg process pushes to external RTMP/RTMPS endpoint
   - Stderr monitored for errors (connection drops, encoding issues)
   - Auto-restart on failure with exponential backoff (max 5 attempts)

### 3.2 Transcoding & Viewer Delivery Flow

1. **Parallel Transcoding**
   - Ingest Manager also forwards stream to transcoding farm
   - GPU/CPU workers encode multiple profiles (1080p60/720p30/480p30/360p30)
   - Profiles tagged with bandwidth metadata (5Mbps/2.5Mbps/1.5Mbps/800kbps)

2. **Segmentation**
   - Packager generates HLS (6s segments) or LL-HLS (0.5s parts)
   - DASH segments with CMAF format for universal compatibility
   - Manifest files (m3u8/mpd) updated in real-time

3. **CDN Distribution**
   - Segments pushed to origin server
   - CDN edge nodes cache segments (TTL: 6-10s)
   - Viewers request manifest → edge serves nearest cached segments

4. **VOD Archive**
   - Transcoded streams simultaneously written to S3
   - Segments retained for 90 days (configurable)
   - Post-processing: concatenate segments into single MP4

---

## 4. Key Design Decisions

### 4.1 Per-Destination FFmpeg Processes

**Decision**: Spawn separate FFmpeg process for each RTMP destination instead of single multi-output process.

**Rationale**:
- **Fault Isolation**: If YouTube connection fails, Twitch/Facebook streams continue
- **Independent Restart**: Restart only failed destination without disrupting others
- **Per-Destination Monitoring**: Track health, bitrate, errors separately
- **Simplified Backpressure**: Each process has own stdin buffer

**Trade-off**: Higher CPU/memory overhead (~150MB per process), but improves reliability.

### 4.2 Ring Buffer with Drop-Oldest Strategy

**Decision**: Fixed-size circular buffer (256 slots) that drops oldest chunks on overflow.

**Rationale**:
- **Bounded Memory**: Prevents OOM crashes during FFmpeg stalls
- **Latency Control**: Dropping old frames keeps stream "live" vs buffering delays
- **Predictable Behavior**: Buffer size known at compile time, no dynamic allocation

**Trade-off**: Occasional frame drops under heavy load, but preferable to unbounded growth or crash.

### 4.3 EBML Header Preservation

**Decision**: Extract and cache WebM EBML header separately, seed to every FFmpeg process.

**Rationale**:
- **Process Restart**: New FFmpeg instances need header to decode stream
- **Multi-Destination**: All destinations require header initialization
- **Format Compliance**: WebM/Matroska requires header before clusters

**Implementation**: Store in Redis with TTL matching stream duration + 1hr.

### 4.4 Backpressure Propagation

**Decision**: Pause client when any FFmpeg stdin buffer fills OR ring buffer exceeds 80% capacity.

**Rationale**:
- **Prevents Overflow**: Stops ingestion before buffer overflows
- **Multi-Destination Sync**: Slowest destination dictates pace
- **Client-Side Buffering**: Browsers buffer in MediaRecorder, mobile apps in native queue

**Mechanism**:
- Socket.IO: emit `backpressure-pause` / `backpressure-resume` events
- Client responds by pausing MediaRecorder or native encoder

### 4.5 Exponential Backoff Restart Policy

**Decision**: Restart failed FFmpeg processes with delay = `min(2^attempt * 1s, 60s)`, max 5 attempts.

**Rationale**:
- **Transient Failures**: Network blips, temporary RTMP server issues
- **Rate Limit Protection**: Avoid hammering external APIs with rapid retries
- **Circuit Breaker**: Permanent failures detected after 5 attempts (~2 minutes)

**Logging**: All restart events logged with PID, destination, attempt count, exit code.

---

## 5. Scalability & Performance

### 5.1 Horizontal Scaling

| Component | Scaling Strategy | Load Balancer |
|-----------|------------------|---------------|
| Gateway | Stateless, scale pods behind LB | NGINX / ALB with WebSocket support |
| Ingest Manager | Shard by streamKey hash | Consistent hashing (Redis Cluster) |
| FFmpeg Adapter | Colocate with Ingest (1:1 mapping) | N/A (part of ingest pod) |
| Transcoding Farm | Auto-scale GPU/CPU nodes based on queue depth | Kubernetes HPA, custom metrics |
| Packager | Stateless, scale per stream | Round-robin or least-connections |
| CDN/Edge | Auto-scale globally | Provider-managed (CloudFront, Cloudflare) |

### 5.2 Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| End-to-End Latency | < 3s (LL-HLS), < 8s (HLS) | Glass-to-glass from encoder to player |
| Throughput | 10,000 concurrent 1080p streams | Per-datacenter capacity |
| FFmpeg Restart Time | < 2s | Time to re-establish RTMP connection |
| Buffer Overhead | < 100MB per stream | Ingest Manager memory usage |
| CPU per Stream | ~200% (2 cores) | FFmpeg transcoding (1080p → 4 profiles) |
| GPU Utilization | 70-85% sustained | NVENC encoder on T4 GPUs |

### 5.3 Bottleneck Mitigation

**Network I/O**:
- 10Gbps NICs on ingest/transcode nodes
- TCP tuning: increase `net.core.rmem_max`, `net.ipv4.tcp_rmem`
- Connection pooling for RTMP (reuse TCP connections)

**CPU**:
- Hardware-accelerated encoding (NVENC, QuickSync, VideoToolbox)
- Copy codecs where possible (`-c copy`) to avoid re-encoding

**Memory**:
- Bounded buffers everywhere (ring buffer, FFmpeg stdin, transcoder queue)
- Aggressive GC tuning in Node.js (`--max-old-space-size=4096`)

**Disk I/O**:
- SSD for temporary segment storage
- Async writes to S3 (don't block ingest)

---

## 6. Reliability & Fault Tolerance

### 6.1 Failure Modes & Recovery

| Failure Mode | Detection | Recovery | SLA Impact |
|--------------|-----------|----------|------------|
| FFmpeg crash | Stderr monitor detects exit code ≠ 0 | Auto-restart with backoff | < 5s interruption per destination |
| RTMP connection drop | stderr: "Connection refused" or timeout | Reconnect with exponential backoff | 2-10s per attempt |
| Ingest node crash | Health check fails (HTTP /health 503) | K8s reschedules pod, clients reconnect | 10-30s reconnection |
| Transcode worker OOM | Pod evicted (OOMKilled) | K8s replaces pod, jobs requeued | 30-60s for new worker |
| S3 write failure | 500/503 from S3 API | Retry with jitter, log error, alert | No impact on live (VOD delayed) |
| CDN origin down | 504 Gateway Timeout | Failover to secondary origin | < 1s (DNS/anycast failover) |

### 6.2 High Availability Setup

**Multi-Region Deployment**:
- Active-active in 3 regions (us-east-1, eu-west-1, ap-south-1)
- GeoDNS routes clients to nearest region
- Cross-region replication for stream metadata (DynamoDB Global Tables)

**Redundancy**:
- 3+ replicas for Gateway, Ingest Manager
- 2+ replicas for Orchestrator (active-passive with leader election)
- Multi-AZ for RDS/Redis

**Health Checks**:
- HTTP /health endpoint (every 5s)
- Checks: can connect to Redis, can spawn FFmpeg, disk space > 20%
- Fail 3 consecutive checks → remove from LB pool

---

## 7. Security

### 7.1 Authentication & Authorization

**Stream Tokens**:
- JWT signed with HS256, 5-minute expiry
- Payload: `{userId, streamKey, destinations[], iat, exp}`
- Validated on every `start-stream` event
- Refresh token flow for long streams (client requests new token every 4 min)

**RTMP URL Security**:
- Stream keys never logged or exposed to clients
- RTMP URLs stored encrypted in database (AES-256-GCM)
- Rotated after stream ends or every 24 hours

**API Keys**:
- External RTMP platforms (YouTube, Twitch) use OAuth2 or API keys
- Stored in Secrets Manager (AWS Secrets Manager, HashiCorp Vault)
- Automatic rotation every 90 days

### 7.2 Input Validation & Sanitization

**WebSocket Payloads**:
- JSON schema validation (ajv library)
- Max payload size: 10MB
- Reject payloads with suspicious patterns (`<script>`, SQL keywords)

**FFmpeg Command Injection Prevention**:
- **Never use shell=true** in child_process.spawn
- Use args array: `spawn('ffmpeg', ['-re', '-i', 'pipe:0', ...])`
- Whitelist RTMP URL schemas: `rtmp://`, `rtmps://`
- Reject `file://`, `javascript:`, `data:` URLs

**Stream Key Validation**:
- Alphanumeric + hyphens only: `/^[a-zA-Z0-9-]{8,64}$/`
- Check against database before accepting stream

### 7.3 Rate Limiting

| Resource | Limit | Window | Action on Exceed |
|----------|-------|--------|------------------|
| Stream starts | 3 per client | 1 minute | HTTP 429, log event |
| Data chunks | 1000 per stream | 1 second | Backpressure pause |
| WebSocket messages | 100 per connection | 10 seconds | Disconnect with warning |
| API calls (Orchestrator) | 60 per IP | 1 minute | HTTP 429 |

### 7.4 DDoS Mitigation

- CloudFlare / AWS Shield in front of Gateway
- SYN cookies enabled on load balancers
- Connection limits: max 50,000 concurrent WebSockets per Gateway pod
- IP-based blacklisting (auto-ban after 10 failed auth attempts in 1 min)

---

## 8. Monitoring & Observability

### 8.1 Metrics (Prometheus)

**Ingest Metrics**:
```
ingest_active_streams_count
ingest_buffer_size_bytes{stream_id}
ingest_chunks_received_total{stream_id}
ingest_chunks_dropped_total{stream_id}
ingest_backpressure_events_total{stream_id, action=pause|resume}
```

**FFmpeg Metrics**:
```
ffmpeg_processes_active_count{destination}
ffmpeg_restart_count_total{destination, stream_id}
ffmpeg_process_cpu_percent{destination, stream_id}
ffmpeg_process_memory_bytes{destination, stream_id}
ffmpeg_stderr_errors_total{destination, error_type}
```

**Transcoding Metrics**:
```
transcode_queue_depth{profile}
transcode_job_duration_seconds{profile}
transcode_gpu_utilization_percent{node}
transcode_failures_total{profile, reason}
```

**CDN Metrics**:
```
cdn_requests_total{region, cache_status=hit|miss}
cdn_bandwidth_bytes_total{region}
cdn_error_rate{region, status_code}
```

### 8.2 Logging (ELK Stack)

**Structured Logs** (JSON format):
```json
{
  "timestamp": "2025-11-12T10:30:45.123Z",
  "level": "error",
  "component": "ffmpeg-adapter",
  "stream_id": "abc123",
  "destination": "youtube",
  "pid": 54321,
  "message": "FFmpeg process exited with code 1",
  "stderr": "Connection to rtmps://a.rtmp.youtube.com:443/live2 refused"
}
```

**Log Retention**:
- Hot: 7 days in Elasticsearch
- Warm: 30 days in S3 (compressed)
- Cold: 1 year in Glacier

### 8.3 Alerting Rules

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| High FFmpeg Restart Rate | > 10 restarts/min | Critical | Page on-call, check RTMP endpoints |
| Buffer Overflow | > 90% capacity for 1 min | Warning | Auto-scale ingest pods |
| Transcode Queue Backlog | > 500 jobs pending for 5 min | Warning | Auto-scale GPU workers |
| S3 Write Failure | > 5% error rate | Warning | Check S3 service health |
| CDN Error Spike | > 10% 5xx responses | Critical | Failover to backup CDN |

### 8.4 Tracing (Optional)

- OpenTelemetry spans for end-to-end latency tracking
- Trace ID propagated: Client → Gateway → Ingest → FFmpeg → RTMP
- Jaeger UI for visualizing bottlenecks

---

## 9. Data Models

### 9.1 Stream Metadata (PostgreSQL)

```sql
CREATE TABLE streams (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    stream_key VARCHAR(64) UNIQUE NOT NULL,
    title VARCHAR(255),
    status ENUM('idle', 'connecting', 'live', 'stopping', 'ended') DEFAULT 'idle',
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE stream_destinations (
    id UUID PRIMARY KEY,
    stream_id UUID NOT NULL,
    platform ENUM('youtube', 'twitch', 'facebook'),
    rtmp_url_encrypted BYTEA NOT NULL,
    status ENUM('pending', 'active', 'failed', 'stopped'),
    restart_attempts INT DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (stream_id) REFERENCES streams(id)
);
```

### 9.2 Runtime State (Redis)

**Stream Session**:
```
Key: stream:{streamKey}
Value: {
    userId, 
    ingestNodeId, 
    startedAt, 
    ebmlHeader: <Buffer>,
    destinations: [
        {platform, rtmpUrl, ffmpegPid, status, restartAttempts}
    ]
}
TTL: stream duration + 1 hour
```

**Backpressure State**:
```
Key: backpressure:{streamKey}
Value: {
    isPaused: true|false,
    bufferLevel: 0.87,
    pausedAt: timestamp
}
TTL: 5 minutes
```

---

## 10. Deployment Architecture

### 10.1 Kubernetes Manifest (Simplified)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ingest-manager
spec:
  replicas: 10
  selector:
    matchLabels:
      app: ingest-manager
  template:
    metadata:
      labels:
        app: ingest-manager
    spec:
      containers:
      - name: ingest
        image: livestream/ingest-manager:v1.2.3
        resources:
          requests:
            memory: "2Gi"
            cpu: "2"
          limits:
            memory: "4Gi"
            cpu: "4"
        env:
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: redis-creds
              key: url
        - name: MAX_BUFFER_SIZE
          value: "104857600"  # 100MB
        ports:
        - containerPort: 3000
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 5
```

### 10.2 Infrastructure Components

| Service | Technology | Configuration |
|---------|-----------|---------------|
| Load Balancer | AWS ALB / NGINX | WebSocket support, 60s timeout |
| Container Orchestration | Kubernetes (EKS/GKE) | 3 node pools (gateway, ingest, transcode) |
| Database | PostgreSQL (RDS) | Multi-AZ, r6g.2xlarge |
| Cache | Redis Cluster | 6 shards, 2 replicas each |
| Object Storage | S3 | Intelligent-Tiering, Cross-Region Replication |
| CDN | CloudFront | 50+ edge locations, real-time logs |
| Secrets Management | AWS Secrets Manager | Auto-rotation enabled |

### 10.3 Cost Estimation (Monthly, 1000 concurrent streams)

| Component | Unit Cost | Quantity | Total |
|-----------|-----------|----------|-------|
| Compute (ingest/transcode) | $0.30/hr (c6i.2xlarge) | 50 instances | $10,800 |
| GPU Workers | $1.20/hr (g4dn.xlarge) | 20 instances | $17,280 |
| RDS PostgreSQL | $0.50/hr (r6g.2xlarge Multi-AZ) | 2 instances | $720 |
| Redis Cluster | $0.35/hr (r6g.xlarge) | 6 nodes | $1,512 |
| S3 Storage | $0.023/GB | 500 TB | $11,500 |
| CloudFront | $0.085/GB | 2 PB | $170,000 |
| Data Transfer Out | $0.09/GB | 2 PB | $180,000 |
| **TOTAL** | | | **~$391,812/month** |

*Assumptions: 1000 streams × 5 Mbps × 720 hrs/month = 2PB egress*

---

## 11. Future Enhancements

### 11.1 Roadmap (Q1-Q2 2026)

1. **WebRTC Ingestion** (currently MediaRecorder over WS)
   - Lower latency: sub-500ms glass-to-glass
   - Native browser support without MediaRecorder API
   - WHIP protocol compliance

2. **AI-Powered Moderation**
   - Real-time content analysis (nudity, violence detection)
   - Automatic stream takedown on policy violations
   - Transcript generation + sentiment analysis

3. **Interactive Features**
   - Low-latency chat overlay on stream
   - Polls, Q&A, live reactions
   - WebRTC-based co-streaming (multi-host)

4. **Edge Transcoding**
   - Move transcoding closer to ingest (regional POPs)
   - Reduce backhaul bandwidth by 70%
   - Sub-region latency optimization

5. **Advanced Analytics**
   - Real-time viewer heatmaps (which segments most watched)
   - Engagement metrics (average watch time, drop-off points)
   - A/B testing for thumbnail/title optimization

### 11.2 Research Areas

- **AV1 Encoding**: 30% better compression vs H.264, but 10x slower (need hardware encoders)
- **QUIC Protocol**: Replace TCP for RTMP, reduce head-of-line blocking
- **Serverless Transcoding**: AWS Lambda + MediaConvert for cost optimization
- **Blockchain Receipts**: Tamper-proof stream metadata for copyright/licensing

---

## 12. Appendix

### 12.1 Glossary

| Term | Definition |
|------|------------|
| **ABR** | Adaptive Bitrate - dynamically switch quality based on network |
| **EBML** | Extensible Binary Meta Language - WebM container header format |
| **LL-HLS** | Low-Latency HLS - Apple's protocol for < 3s latency |
| **RTMP** | Real-Time Messaging Protocol - streaming protocol (Adobe) |
| **RTMPS** | RTMP over TLS/SSL (secure) |
| **WHIP** | WebRTC-HTTP Ingestion Protocol (IETF draft) |
| **CMAF** | Common Media Application Format - unified HLS/DASH |

### 12.2 Reference Documentation

- [FFmpeg Documentation](https://ffmpeg.org/documentation.html)
- [WebM Container Spec](https://www.webmproject.org/docs/container/)
- [HLS RFC 8216](https://datatracker.ietf.org/doc/html/rfc8216)
- [RTMP Specification](https://www.adobe.com/devnet/rtmp.html)
- [Node.js Stream API](https://nodejs.org/api/stream.html)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/)

### 12.3 Team Contacts

| Role | Team | Slack Channel |
|------|------|---------------|
| Platform Owner | Infrastructure | #livestream-infra |
| Backend Lead | Engineering | #livestream-backend |
| DevOps Lead | SRE | #livestream-sre |
| Security Lead | AppSec | #security-reviews |
| Product Manager | Product | #livestream-product |

---

**Document Version**: 1.0  
**Last Updated**: November 12, 2025  
**Maintained By**: Platform Architecture Team  
**Review Cycle**: Quarterly