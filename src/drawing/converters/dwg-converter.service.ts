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

    // Check if ODA binary exists
    const binExists = await this.binaryExists();
    if (!binExists) {
      throw new Error(
        `ODA File Converter không tìm thấy (${this.bin}). ` +
        `Cài đặt từ https://www.opendesign.com/guestfiles/oda_file_converter hoặc set ODA_CONVERTER_BIN.`,
      );
    }

    // ODAFileConverter <input_dir> <output_dir> <output_version> <output_type> <recurse> <audit>
    const inputDir = path.dirname(dwgPath);
    const cmd = `"${this.bin}" "${inputDir}" "${outDir}" "ACAD2018" "DXF" "0" "1"`;
    this.logger.log(`ODA convert: ${cmd}`);

    await execAsync(cmd, { timeout: 120_000 });

    if (!fs.existsSync(dxfPath)) {
      throw new Error(`ODA conversion failed — DXF output not found at ${dxfPath}`);
    }

    return dxfPath;
  }

  private async binaryExists(): Promise<boolean> {
    try {
      await execAsync(`which "${this.bin}" || where "${this.bin}"`);
      return true;
    } catch {
      return false;
    }
  }
}
