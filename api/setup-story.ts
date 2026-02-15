import { setupStoryPack } from './_lib/geminiServer';
import { SetupStoryRequest } from '../types';

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
    const body: SetupStoryRequest = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const payloadBytes = Buffer.byteLength(JSON.stringify(body || {}), 'utf8');

    if (!body?.storyFile?.data || !body.storyFile.mimeType) {
      return send(res, 400, { error: 'storyFile is required' });
    }

    const result = await setupStoryPack(body.storyFile, body.styleImages || []);
    return send(res, 200, {
      ...result,
      payloadBytes
    });
  } catch (error: any) {
    return send(res, 500, {
      error: error?.message || 'setup-story failed'
    });
  }
}
