FROM golang:1.22-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o yaver-relay .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates curl
COPY --from=builder /app/yaver-relay /usr/local/bin/yaver-relay

# Non-root user
RUN adduser -D -h /app yaver
USER yaver

EXPOSE 4433/udp 8443/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8443/health || exit 1

ENTRYPOINT ["yaver-relay"]
CMD ["serve", "--quic-port=4433", "--http-port=8443"]
