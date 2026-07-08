# dwg2dxf KHÔNG có gói cài sẵn trên Alpine lẫn Debian (đã verify) → không apt/apk được.
# DWG nhỏ parse bằng WASM (libredwg-web, kèm trong node_modules); DWG lớn WASM gãy →
# hiện yêu cầu upload dạng .dxf. Nếu cần convert DWG lớn native: thêm builder-stage
# compile LibreDWG từ source (dwg2dxf) — chưa làm vì cần đánh giá downstream trước.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/main"]
