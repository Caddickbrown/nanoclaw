import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * Transcribe an audio file using local whisper-cli.
 * Telegram voice notes are opus/ogg and must be converted to 16kHz wav first.
 * Returns the transcript string, or null on failure.
 */
export async function transcribeAudioFile(
  filePath: string,
): Promise<string | null> {
  const env = readEnvFile(['WHISPER_BIN', 'WHISPER_MODEL']);
  const whisperBin = env.WHISPER_BIN || 'whisper-cli';
  const model =
    env.WHISPER_MODEL || path.join(process.cwd(), 'data/models/ggml-base.bin');

  const wavPath = path.join(os.tmpdir(), `whisper_${Date.now()}.wav`);
  const outFile = path.join(os.tmpdir(), `whisper_out_${Date.now()}`);
  try {
    // Convert to 16kHz mono wav (required for whisper-cli with opus/ogg input)
    await execFileAsync('ffmpeg', [
      '-i',
      filePath,
      '-ar',
      '16000',
      '-ac',
      '1',
      wavPath,
      '-y',
      '-loglevel',
      'quiet',
    ]);
    await execFileAsync(whisperBin, [
      '-m',
      model,
      '-f',
      wavPath,
      '-nt', // no timestamps
      '--no-prints', // suppress progress/metadata noise
      '-of',
      outFile,
      '-otxt', // write plain text output to ${outFile}.txt
    ]);
    const text = fs.readFileSync(`${outFile}.txt`, 'utf-8').trim();
    return text || null;
  } catch (err) {
    logger.error({ err, filePath }, 'whisper.cpp transcription failed');
    return null;
  } finally {
    fs.unlink(wavPath, () => {});
    fs.unlink(`${outFile}.txt`, () => {});
  }
}
