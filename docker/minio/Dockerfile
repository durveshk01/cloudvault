# MinIO Community is distributed as source only. Build the last official
# release from its immutable commit instead of pulling the removed image.
FROM golang:1.25-alpine AS builder
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
RUN CGO_ENABLED=0 go install github.com/minio/minio@${MINIO_COMMIT}

FROM alpine:3.23
RUN apk add --no-cache ca-certificates curl && mkdir /data
COPY --from=builder /go/bin/minio /usr/local/bin/minio
# Preserve the historical image's UID so existing mounted volumes stay writable.
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
