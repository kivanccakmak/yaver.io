FROM golang:1.22-alpine AS builder
RUN apk add --no-cache git
WORKDIR /build
COPY go.mod go.sum* ./
RUN go mod download 2>/dev/null || true
COPY . .
RUN CGO_ENABLED=0 go build -o yaver-mcp .

FROM alpine:3.19
RUN apk add --no-cache git curl bash python3 nodejs
COPY --from=builder /build/yaver-mcp /usr/local/bin/yaver-mcp
RUN mkdir -p /plugins
EXPOSE 18100
ENV MCP_PASSWORD=""
ENTRYPOINT ["yaver-mcp", "serve", "--http-port=18100", "--plugins-dir=/plugins"]
