# Debian (glibc) thay Alpine: Alpine KHÔNG có gói cung cấp binary dwg2dxf; Debian
# có 'libredwg-tools' (dwg2dxf/dwgread) — cần cho convert DWG lớn (WASM gãy).
# Project không có native npm dep (bcryptjs thuần JS) nên đổi base an toàn.
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
# dwg2dxf: converter DWG→DXF cho file lớn mà WASM libredwg-web OOM-gãy (bản KC 20MB+).
# In rõ ✅/❌ trong build-log. KHÔNG fail build nếu thiếu (WASM vẫn xử lý file nhỏ).
RUN apt-get update \
      && apt-get install -y --no-install-recommends libredwg-tools \
      && rm -rf /var/lib/apt/lists/* \
      || echo "WARN: apt install libredwg-tools failed"; \
    if command -v dwg2dxf >/dev/null 2>&1; then echo "✅ dwg2dxf INSTALLED: $(command -v dwg2dxf)"; \
    else echo "❌ dwg2dxf MISSING — DWG lớn phải upload dạng .dxf"; fi
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/main"]
