import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * DWG → DXF converter using ODA File Converter.
 *
 * Install ODA on Railway via Dockerfile:
 *   RUN apt-get install -y ./ODAFileConverter_*.deb
 *
 * Or via Nixpacks: add odafileconverter to nixpkgs.
 * ODA binary env var: ODA_CONVERTER_BIN (default: ODAFileConverter)
 */
@Injectable()
export class DwgConverterService {
  private readonly logger = new Logger(DwgConverterService.name);
  private readonly bin: string;

  constructor() {
    this.bin = process.env.ODA_CONVERTER_BIN ?? 'ODAFileConverter';
  }

  async convert(dwgPath: string): Promise<string> {
    const outDir = path.dirname(dwgPath);
    const baseName = path.basename(dwgPath, path.extname(dwgPath));
    const dxfPath = path.join(outDir, `${baseName}.dxf`);

    this.logger.log(`[DwgConverter] Converting: ${dwgPath}`);
    this.logger.log(`[DwgConverter] ODA binary: ${this.bin}`);
    this.logger.log(`[DwgConverter] Output dir: ${outDir}`);
    this.logger.log(`[DwgConverter] Expected DXF: ${dxfPath}`);

    const binExists = await this.binaryExists();
    this.logger.log(`[DwgConverter] Binary exists: ${binExists}`);

    if (!binExists) {
      throw new Error(
        `ODA File Converter not found (${this.bin}). ` +
        `Install from https://www.opendesign.com/guestfiles/oda_file_converter or set ODA_CONVERTER_BIN env var.`,
      );
    }

    // ODAFileConverter <input_dir> <output_dir> <output_version> <output_type> <recurse> <audit>
    const inputDir = path.dirname(dwgPath);
    const cmd = `"${this.bin}" "${inputDir}" "${outDir}" "ACAD2018" "DXF" "0" "1"`;
    this.logger.log(`[DwgConverter] Running: ${cmd}`);

    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 120_000 });
      if (stdout) this.logger.log(`[DwgConverter] stdout: ${stdout}`);
      if (stderr) this.logger.warn(`[DwgConverter] stderr: ${stderr}`);
    } catch (err: any) {
      this.logger.error(`[DwgConverter] exec error: ${err.message}`);
      throw err;
    }

    if (!fs.existsSync(dxfPath)) {
      throw new Error(`ODA conversion failed — DXF output not found at ${dxfPath}`);
    }

    this.logger.log(`[DwgConverter] Success: ${dxfPath}`);
    return dxfPath;
  }

  private async binaryExists(): Promise<boolean> {
    try {
      const isWin = process.platform === 'win32';
      const checkCmd = isWin ? `where "${this.bin}"` : `which "${this.bin}"`;
      await execAsync(checkCmd);
      return true;
    } catch {
      return false;
    }
  }
}
