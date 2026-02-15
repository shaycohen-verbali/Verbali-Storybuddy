import { runTurnPipeline } from './_lib/geminiServer';
import { TurnRequest } from '../types';

const send = (res: any, status: number, data: unknown) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body: TurnRequest = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const payloadBytes = Buffer.byteLength(JSON.stringify(body || {}), 'utf8');

    if (!body?.audioBase64 || !body.mimeType || !body.storyBrief) {
      return send(res, 400, { error: 'audioBase64, mimeType, and storyBrief are required' });
    }

    const result = await runTurnPipeline(
      body.audioBase64,
      body.mimeType,
      body.storyBrief,
      body.artStyle,
      body.stylePrimer || [],
      body.history || []
    );

    return send(res, 200, {
      ...result,
      payloadBytes
    });
  } catch (error: any) {
    return send(res, 500, {
      error: error?.message || 'turn failed'
    });
  }
}
