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
RUN apk add --no-cache libredwg || echo "WARN: libredwg unavailable — DWG fallback disabled"
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/main"]
