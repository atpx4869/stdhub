/**
 * 国家 CMA 真实数据提供者 —— 调用 Python 抓取脚本获取场所级能力数据。
 *
 * 调用方式：python scripts/cma_fetch_place.py --cert <certCode> --place-id <placeId> --json
 * 脚本输出 JSON 到 stdout，stderr 保留调试日志。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { NatCmaCapability, NatCmaDetail, NatCmaProvider } from '../../services/nat-cma-service';

interface FetchPlaceResult {
  place: {
    placeId: string;
    certCode: string;
    placeName: string;
    placeAddress: string;
    placeType: string;
  };
  abilities: Array<{
    "大类": string;
    "类别": string;
    "产品/项目/参数": string;
    "标准名称": string;
    "标准编号": string;
  }>;
  total: number;
  remote_total: number | null;
  unique_count: number;
  synced_at: string;
}

function getPythonCommand(): string {
  // 优先 py（Windows），其次 python3，最后 python
  for (const cmd of ['py', 'python3', 'python']) {
    try {
      const { execSync } = require('node:child_process');
      execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 5000 });
      return cmd;
    } catch { /* try next */ }
  }
  return 'python';
}

const PYTHON_CMD = getPythonCommand();
const SCRIPT_PATH = path.join(__dirname, '..', '..', '..', 'scripts', 'cma_fetch_place.py');

export class PythonCmaProvider implements NatCmaProvider {
  async scrapeFull(
    _publicDetailId: string,
    onProgress?: (stage: string, fetched: number, total: number) => void,
    certCode?: string,
    maxPages?: number,
  ): Promise<{ detail: NatCmaDetail; capabilities: NatCmaCapability[] }> {
    if (!certCode) {
      throw new Error('certCode is required for PythonCmaProvider');
    }

    onProgress?.('connecting', 0, 0);

    // 先获取场所列表
    const places = await this.listPlaces(certCode);
    if (!places.length) {
      throw new Error(`证书 ${certCode} 未找到场所`);
    }

    // 抓取所有场所的能力（取第一个场所 —— 后端按 certCode 聚合）
    // 实际上脚本一次只能抓一个场所，我们取主场所
    const primaryPlace = places.find(p => p.placeType === '主场所') || places[0];
    onProgress?.('downloading', 0, 0);

    console.log(`[nat-cma-python] fetching place ${primaryPlace.placeId} for cert ${certCode}`);
    const result = await this.fetchPlace(certCode, primaryPlace.placeId, onProgress, maxPages);
    console.log(`[nat-cma-python] got ${result.abilities.length} abilities from Python`);
    const capabilities: NatCmaCapability[] = result.abilities.map((a, i) => ({
      jcnlId: `row-${i + 1}`,
      type: a["类别"],
      cpName: a["产品/项目/参数"],
      yjbzNameNumber: a["标准名称"],
      yjbzNumber: a["标准编号"],
      xzfw: "",
      parentName: a["大类"],
    }));

    console.log(`[nat-cma-python] converted ${capabilities.length} capabilities`);
    onProgress?.('complete', capabilities.length, capabilities.length);

    return {
      detail: {
        certStatus: '有效',
        licDate: '',
        licValidTimeBegin: '',
        licValidTimeEnd: '',
      },
      capabilities,
    };
  }

  private listPlaces(certCode: string): Promise<Array<{ placeId: string; placeType: string; placeName: string }>> {
    return new Promise((resolve, reject) => {
      const proc = spawn(PYTHON_CMD, [
        SCRIPT_PATH,
        '--cert', certCode,
        '--list-places',
        '--json',
      ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });

      let stdout = '';
      let stderrBuf = '';
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('[nat-cma-python] stderr:', stderrBuf.slice(-500));
          reject(new Error(`Python list-places failed (exit ${code})`));
          return;
        }
        try {
          const data = JSON.parse(stdout.trim());
          resolve(data.places || []);
        } catch (e) {
          reject(new Error(`Failed to parse Python output: ${e}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private fetchPlace(
    certCode: string,
    placeId: string,
    onProgress?: (stage: string, fetched: number, total: number) => void,
    maxPages?: number,
  ): Promise<FetchPlaceResult> {
    return new Promise((resolve, reject) => {
      const args = [
        SCRIPT_PATH,
        '--cert', certCode,
        '--place-id', placeId,
        '--json',
      ];
      if (maxPages && maxPages > 0) {
        args.push('--max-pages', String(maxPages));
      }
      const proc = spawn(PYTHON_CMD, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_600_000 }); // 1h timeout for large datasets

      let stdout = '';
      let stderrBuf = '';
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrBuf += text;
        // 解析结构化进度 JSON 行
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('{')) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.type === 'progress' && onProgress) {
              const phase = msg.phase || 'downloading';
              const fetched = msg.fetched || 0;
              const total = msg.total || 0;
              if (phase === 'cooldown') {
                onProgress('cooling', fetched, total);
              } else {
                onProgress(phase, fetched, total);
              }
            }
          } catch { /* not JSON, ignore */ }
        }
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error('[nat-cma-python] stderr:', stderrBuf.slice(-500));
          reject(new Error(`Python fetch-place failed (exit ${code})`));
          return;
        }
        try {
          const data = JSON.parse(stdout.trim());
          console.log(`[nat-cma-python] fetched ${data.total} abilities (unique: ${data.unique_count}, remote: ${data.remote_total})`);
          resolve(data);
        } catch (e) {
          reject(new Error(`Failed to parse Python output: ${e}`));
        }
      });

      proc.on('error', reject);
    });
  }
}
