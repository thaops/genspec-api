import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * DWG → DXF converter.
 *
 * Backend priority (auto-detected at first use):
 *   1. ODA File Converter — set ODA_CONVERTER_BIN env var (default: ODAFileConverter)
 *   2. dwg2dxf (libredwg) — available via `apk add libredwg` on Alpine
 *
 * Railway/Docker: add `RUN apk add --no-cache libredwg` to Dockerfile.
 */
@Injectable()
export class DwgConverterService {
  private readonly logger = new Logger(DwgConverterService.name);
  private readonly odaBin: string;
  private _backend: 'oda' | 'libredwg' | null | undefined = undefined; // undefined = not detected yet

  constructor() {
    this.odaBin = process.env.ODA_CONVERTER_BIN ?? 'ODAFileConverter';
  }

  async convert(dwgPath: string): Promise<string> {
    const outDir = path.dirname(dwgPath);
    const baseName = path.basename(dwgPath, path.extname(dwgPath));
    const dxfPath = path.join(outDir, `${baseName}.dxf`);

    this.logger.log(`[DwgConverter] Input:  ${dwgPath}`);
    this.logger.log(`[DwgConverter] Output: ${dxfPath}`);

    const backend = await this.detectBackend();
    this.logger.log(`[DwgConverter] Backend: ${backend ?? 'none'}`);

    if (!backend) {
      throw new Error(
        `DWG format không được hỗ trợ trực tiếp. ` +
        `Vui lòng mở file trong AutoCAD → File → Save As → DXF, sau đó upload file .dxf.`,
      );
    }

    if (backend === 'oda') {
      await this.runOda(dwgPath, outDir);
    } else {
      await this.runLibredwg(dwgPath, dxfPath);
    }

    if (!fs.existsSync(dxfPath)) {
      throw new Error(`Conversion completed but DXF not found at ${dxfPath}`);
    }

    this.logger.log(`[DwgConverter] Success: ${dxfPath}`);
    return dxfPath;
  }

  private async runOda(dwgPath: string, outDir: string) {
    const inputDir = path.dirname(dwgPath);
    const cmd = `"${this.odaBin}" "${inputDir}" "${outDir}" "ACAD2018" "DXF" "0" "1"`;
    this.logger.log(`[DwgConverter] ODA cmd: ${cmd}`);
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 120_000 });
      if (stdout) this.logger.log(`[DwgConverter] ODA stdout: ${stdout.trim()}`);
      if (stderr) this.logger.warn(`[DwgConverter] ODA stderr: ${stderr.trim()}`);
    } catch (err: any) {
      this.logger.error(`[DwgConverter] ODA exec error: ${err.message}`);
      throw err;
    }
  }

  private async runLibredwg(dwgPath: string, dxfPath: string) {
    const cmd = `dwg2dxf "${dwgPath}" -o "${dxfPath}"`;
    this.logger.log(`[DwgConverter] libredwg cmd: ${cmd}`);
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 120_000 });
      if (stdout) this.logger.log(`[DwgConverter] libredwg stdout: ${stdout.trim()}`);
      if (stderr) this.logger.warn(`[DwgConverter] libredwg stderr: ${stderr.trim()}`);
    } catch (err: any) {
      this.logger.error(`[DwgConverter] libredwg exec error: ${err.message}`);
      throw err;
    }
  }

  /** Detects available backend once and caches result. */
  private async detectBackend(): Promise<'oda' | 'libredwg' | null> {
    if (this._backend !== undefined) return this._backend;

    if (await this.commandExists(this.odaBin)) {
      this.logger.log(`[DwgConverter] Detected backend: ODA (${this.odaBin})`);
      this._backend = 'oda';
    } else if (await this.commandExists('dwg2dxf')) {
      this.logger.log(`[DwgConverter] Detected backend: libredwg (dwg2dxf)`);
      this._backend = 'libredwg';
    } else {
      this.logger.warn(`[DwgConverter] No backend found — ODA (${this.odaBin}) and dwg2dxf both missing`);
      this._backend = null;
    }

    return this._backend;
  }

  private async commandExists(cmd: string): Promise<boolean> {
    try {
      const isWin = process.platform === 'win32';
      await execAsync(isWin ? `where "${cmd}"` : `which "${cmd}"`);
      return true;
    } catch {
      return false;
    }
  }
}
