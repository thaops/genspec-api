FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
# dwg2dxf: fallback converter cho DWG lớn/phức tạp mà WASM libredwg-web parse gãy
# (vd bản kết cấu 20MB+). DwgConverterService tự dò 'dwg2dxf' trong PATH.
# libredwg nằm ở repo 'community' — bật rõ + thử 'libredwg-tools' rồi 'libredwg'.
# KHÔNG fail build nếu thiếu (WASM vẫn xử lý file nhỏ) — build-log in rõ có/không.
RUN apk add --no-cache libredwg-tools 2>/dev/null \
      || apk add --no-cache --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community libredwg 2>/dev/null \
      || apk add --no-cache libredwg 2>/dev/null \
      || true; \
    if command -v dwg2dxf >/dev/null 2>&1; then echo "✅ dwg2dxf INSTALLED: $(command -v dwg2dxf)"; \
    else echo "❌ dwg2dxf MISSING — DWG lớn phải upload dạng .dxf"; fi
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/main"]
